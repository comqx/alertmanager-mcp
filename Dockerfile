# Base image: Node.js 18 (LTS) Alpine for a small footprint
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files and install all dependencies (including dev dependencies)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build the application
RUN npm run build

# Create production image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built application from builder stage
COPY --from=builder /app/build ./build

# Set environment variables
ENV NODE_ENV=production

# Change ownership of the application files to 'node' user
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Set entrypoint
ENTRYPOINT ["node", "build/index.js"]