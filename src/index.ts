import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Basic configuration
const DEFAULT_ALERTMANAGER_URL = "http://localhost:9093";
const DEFAULT_TIMEOUT = 10000; // 10 seconds

// Create server instance
const server = new McpServer({
  name: "alertmanager",
  version: "1.0.0",
});

// Helper function for Alertmanager communication
async function fetchFromAlertmanager(path: string, options: RequestInit = {}): Promise<any> {
  const baseUrl = process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL;
  const url = `${baseUrl}/api/v2/${path}`;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Alertmanager API error: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error fetching from Alertmanager: ${errorMessage}`);
    throw error;
  }
}

// Alert-related type definitions
interface AlertLabel {
  [key: string]: string;
}

interface AlertAnnotation {
  [key: string]: string;
}

interface AlertStatus {
  state: string;
  silencedBy: string[];
  inhibitedBy: string[];
}

interface Alert {
  fingerprint: string;
  status: AlertStatus;
  labels: AlertLabel;
  annotations: AlertAnnotation;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
}

interface FormattedAlert {
  fingerprint: string;
  alertname: string;
  severity: string;
  summary: string;
  description: string;
  startsAt: string;
  status: {
    state: string;
    silenced: boolean;
    inhibited: boolean;
  };
  labels: AlertLabel;
}

interface Silence {
  id: string;
  status: {
    state: string;
  };
  createdBy: string;
  comment: string;
  startsAt: string;
  endsAt: string;
  matchers: Array<{
    name: string;
    value: string;
    isRegex: boolean;
  }>;
}

// Tool to retrieve current list of alerts
server.tool(
  "get-alerts",
  {
    filter: z.string().optional().describe("Filtering query (e.g. alertname=~'.*CPU.*')"),
    silenced: z.boolean().optional().describe("Include silenced alerts"),
    inhibited: z.boolean().optional().describe("Include inhibited alerts"),
    active: z.boolean().optional().describe("Include active alerts (default: true)"),
  },
  async ({ filter, silenced = false, inhibited = false, active = true }) => {
    try {
      // Build query parameters
      const params = new URLSearchParams();
      if (filter) params.append("filter", filter);
      if (silenced) params.append("silenced", "true");
      if (inhibited) params.append("inhibited", "true");
      if (!active) params.append("active", "false");
      
      // Fetch alerts
      const queryString = params.toString();
      const path = `alerts${queryString ? '?' + queryString : ''}`;
      const alerts = await fetchFromAlertmanager(path) as Alert[];
      
      // Format alerts
      const formattedAlerts = alerts.map((alert: Alert): FormattedAlert => ({
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `Error fetching alerts: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
);

// Tool to get detailed information about a specific alert
server.tool(
  "get-alert-details",
  {
    fingerprint: z.string().describe("Alert fingerprint"),
  },
  async ({ fingerprint }) => {
    try {
      // Fetch alert list
      const alerts = await fetchFromAlertmanager('alerts') as Alert[];
      
      // Find the alert matching the fingerprint
      const alert = alerts.find((a: Alert) => a.fingerprint === fingerprint);
      
      if (!alert) {
        return {
          content: [{
            type: "text",
            text: `Alert with fingerprint ${fingerprint} not found`
          }],
          isError: true
        };
      }
      
      // Format the detailed alert information
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `Error fetching alert details: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
);

// Tool to create a silence for alerts
server.tool(
  "create-silence",
  {
    matchers: z.array(z.object({
      name: z.string().describe("Matcher name (e.g. alertname)"),
      value: z.string().describe("Matcher value (e.g. HighCPULoad)"),
      isRegex: z.boolean().optional().describe("Use regex matching"),
    })).describe("List of matchers for alerts"),
    startsAt: z.string().optional().describe("Silence start time (ISO8601 format, default is current time)"),
    endsAt: z.string().describe("Silence end time (ISO8601 format)"),
    createdBy: z.string().describe("Username who created the silence"),
    comment: z.string().describe("Reason or explanation for the silence"),
  },
  async ({ matchers, startsAt, endsAt, createdBy, comment }) => {
    try {
      // Prepare silence data
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
      
      // Create the silence
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `Error creating silence: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
);

// Tool to get list of silences
server.tool(
  "get-silences",
  {
    filter: z.string().optional().describe("Filtering query (e.g. createdBy=~'.*admin.*')"),
  },
  async ({ filter }) => {
    try {
      // Build query parameters
      const params = new URLSearchParams();
      if (filter) params.append("filter", filter);
      
      // Fetch silences
      const queryString = params.toString();
      const path = `silences${queryString ? '?' + queryString : ''}`;
      const silences = await fetchFromAlertmanager(path) as Silence[];
      
      // Format silences
      const formattedSilences = silences.map((silence: Silence) => ({
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `Error fetching silences: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
);

// Tool to delete a silence
server.tool(
  "delete-silence",
  {
    silenceId: z.string().describe("ID of the silence to delete"),
  },
  async ({ silenceId }) => {
    try {
      // Delete the silence
      await fetchFromAlertmanager(`silence/${silenceId}`, {
        method: 'DELETE',
      });
      
      return {
        content: [{
          type: "text",
          text: `Successfully deleted silence with ID: ${silenceId}`
        }]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `Error deleting silence: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
);

// Tool to get alert groups
server.tool(
  "get-alert-groups",
  {
    active: z.boolean().optional().describe("Include active alerts (default: true)"),
    silenced: z.boolean().optional().describe("Include silenced alerts"),
    inhibited: z.boolean().optional().describe("Include inhibited alerts"),
  },
  async ({ active = true, silenced = false, inhibited = false }) => {
    try {
      // Build query parameters
      const params = new URLSearchParams();
      if (!active) params.append("active", "false");
      if (silenced) params.append("silenced", "true");
      if (inhibited) params.append("inhibited", "true");
      
      // Fetch alert groups
      const queryString = params.toString();
      const path = `alerts/groups${queryString ? '?' + queryString : ''}`;
      const groups = await fetchFromAlertmanager(path);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(groups, null, 2)
        }]
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `Error fetching alert groups: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
);

// Main process
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Alertmanager MCP Server started on stdio");
}

main().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error("Fatal error in main():", errorMessage);
  process.exit(1);
});