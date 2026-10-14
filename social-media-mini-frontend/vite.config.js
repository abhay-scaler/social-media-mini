import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // All REST API calls go to the API Gateway
      '/api': 'http://localhost:5000',
      // Socket.io handshake and WebSocket upgrade go directly to post-service
      '/socket.io': {
        target: 'http://localhost:3003',
        ws: true,
      },
    },
  },
})
