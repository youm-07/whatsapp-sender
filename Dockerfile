# Use the official Playwright image (includes Node.js + browsers + dependencies)
FROM mcr.microsoft.com/playwright:v1.49.1-focal

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Expose port 3000
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV HEADLESS=true

# Start the application
CMD ["npm", "start"]
