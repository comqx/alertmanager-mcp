# Base image: Node.js 18 (LTS) Alpine for a small footprint
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies first (for better caching)
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copy source code
COPY build/ ./build/

# Set environment variables
ENV NODE_ENV=production

# Expose port if needed (not required for MCP stdio connections)
# EXPOSE 3000

# Set entrypoint
ENTRYPOINT ["node", "build/index.js"]
