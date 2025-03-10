import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// 基本的な設定
const DEFAULT_ALERTMANAGER_URL = "http://localhost:9093";
const DEFAULT_TIMEOUT = 10000; // 10 seconds

// サーバーインスタンスの作成
const server = new McpServer({
  name: "alertmanager",
  version: "1.0.0",
});

// Alertmanagerとの通信用ヘルパー関数
async function fetchFromAlertmanager(path: string, options = {}) {
  const baseUrl = process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL;
  const url = `${baseUrl}/api/v2/${path}`;
  
  try {
    const response = await fetch(url, {
      timeout: DEFAULT_TIMEOUT,
      ...options
    });
    
    if (!response.ok) {
      throw new Error(`Alertmanager API error: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`Error fetching from Alertmanager: ${error.message}`);
    throw error;
  }
}

// 現在のアラート一覧を取得するツール
server.tool(
  "get-alerts",
  {
    filter: z.string().optional().describe("フィルタリングクエリ（例: alertname=~'.*CPU.*'）"),
    silenced: z.boolean().optional().describe("サイレンス中のアラートも含めるか"),
    inhibited: z.boolean().optional().describe("抑制中のアラートも含めるか"),
    active: z.boolean().optional().describe("アクティブなアラートを含めるか（デフォルト: true）"),
  },
  async ({ filter, silenced = false, inhibited = false, active = true }) => {
    try {
      // クエリパラメータの構築
      const params = new URLSearchParams();
      if (filter) params.append("filter", filter);
      if (silenced) params.append("silenced", "true");
      if (inhibited) params.append("inhibited", "true");
      if (!active) params.append("active", "false");
      
      // アラートの取得
      const queryString = params.toString();
      const path = `alerts${queryString ? '?' + queryString : ''}`;
      const alerts = await fetchFromAlertmanager(path);
      
      // アラートの整形
      const formattedAlerts = alerts.map(alert => ({
        fingerprint: alert.fingerprint,
        alertname: alert.labels.alertname,
        severity: alert.labels.severity || 'unknown',
        summary: alert.annotations.summary || 'No summary provided',
        description: alert.annotations.description || 'No description provided',
        startsAt: alert.startsAt,
        status: {
          state: alert.status.state,
          silenced: alert.status.silencedBy.length > 0,
          inhibited: alert.status.inhibitedBy.length > 0,
        },
        labels: alert.labels,
      }));
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(formattedAlerts, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error fetching alerts: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// 特定のアラートの詳細情報を取得するツール
server.tool(
  "get-alert-details",
  {
    fingerprint: z.string().describe("アラートのフィンガープリント"),
  },
  async ({ fingerprint }) => {
    try {
      // アラート一覧を取得
      const alerts = await fetchFromAlertmanager('alerts');
      
      // フィンガープリントに一致するアラートを検索
      const alert = alerts.find(a => a.fingerprint === fingerprint);
      
      if (!alert) {
        return {
          content: [{
            type: "text",
            text: `Alert with fingerprint ${fingerprint} not found`
          }],
          isError: true
        };
      }
      
      // アラートの詳細情報を整形
      const details = {
        fingerprint: alert.fingerprint,
        alertname: alert.labels.alertname,
        labels: alert.labels,
        annotations: alert.annotations,
        startsAt: alert.startsAt,
        endsAt: alert.endsAt,
        generatorURL: alert.generatorURL,
        status: alert.status,
      };
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(details, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error fetching alert details: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// アラートのサイレンスを作成するツール
server.tool(
  "create-silence",
  {
    matchers: z.array(z.object({
      name: z.string().describe("マッチャーの名前（例: alertname）"),
      value: z.string().describe("マッチャーの値（例: HighCPULoad）"),
      isRegex: z.boolean().optional().describe("正規表現を使用するか"),
    })).describe("アラートにマッチするマッチャーのリスト"),
    startsAt: z.string().optional().describe("サイレンス開始時間（ISO8601形式、デフォルトは現在時刻）"),
    endsAt: z.string().describe("サイレンス終了時間（ISO8601形式）"),
    createdBy: z.string().describe("サイレンスを作成したユーザー名"),
    comment: z.string().describe("サイレンスの理由や説明"),
  },
  async ({ matchers, startsAt, endsAt, createdBy, comment }) => {
    try {
      // サイレンスデータの準備
      const now = new Date().toISOString();
      const silenceData = {
        matchers: matchers.map(m => ({
          name: m.name,
          value: m.value,
          isRegex: m.isRegex || false,
        })),
        startsAt: startsAt || now,
        endsAt,
        createdBy,
        comment,
      };
      
      // サイレンスの作成
      const response = await fetchFromAlertmanager('silences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(silenceData),
      });
      
      return {
        content: [{
          type: "text",
          text: `Successfully created silence with ID: ${response.silenceID}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error creating silence: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// サイレンス一覧を取得するツール
server.tool(
  "get-silences",
  {
    filter: z.string().optional().describe("フィルタリングクエリ（例: createdBy=~'.*admin.*'）"),
  },
  async ({ filter }) => {
    try {
      // クエリパラメータの構築
      const params = new URLSearchParams();
      if (filter) params.append("filter", filter);
      
      // サイレンスの取得
      const queryString = params.toString();
      const path = `silences${queryString ? '?' + queryString : ''}`;
      const silences = await fetchFromAlertmanager(path);
      
      // サイレンスの整形
      const formattedSilences = silences.map(silence => ({
        id: silence.id,
        status: silence.status.state,
        createdBy: silence.createdBy,
        comment: silence.comment,
        startsAt: silence.startsAt,
        endsAt: silence.endsAt,
        matchers: silence.matchers,
      }));
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(formattedSilences, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error fetching silences: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// サイレンスを削除するツール
server.tool(
  "delete-silence",
  {
    silenceId: z.string().describe("削除するサイレンスのID"),
  },
  async ({ silenceId }) => {
    try {
      // サイレンスの削除
      await fetchFromAlertmanager(`silence/${silenceId}`, {
        method: 'DELETE',
      });
      
      return {
        content: [{
          type: "text",
          text: `Successfully deleted silence with ID: ${silenceId}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error deleting silence: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// アラートグループを取得するツール
server.tool(
  "get-alert-groups",
  {
    active: z.boolean().optional().describe("アクティブなアラートを含めるか（デフォルト: true）"),
    silenced: z.boolean().optional().describe("サイレンス中のアラートも含めるか"),
    inhibited: z.boolean().optional().describe("抑制中のアラートも含めるか"),
  },
  async ({ active = true, silenced = false, inhibited = false }) => {
    try {
      // クエリパラメータの構築
      const params = new URLSearchParams();
      if (!active) params.append("active", "false");
      if (silenced) params.append("silenced", "true");
      if (inhibited) params.append("inhibited", "true");
      
      // アラートグループの取得
      const queryString = params.toString();
      const path = `alerts/groups${queryString ? '?' + queryString : ''}`;
      const groups = await fetchFromAlertmanager(path);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(groups, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error fetching alert groups: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// メイン処理
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Alertmanager MCP Server started on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
