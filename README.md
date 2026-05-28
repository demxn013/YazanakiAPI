# Yazanaki API Server

Node.js API that sits between your MySQL database and the Yazanaki Fabric mod.

## Setup

1. Copy `.env.example` to `.env` and fill in your values:
   - DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME → your MySQL credentials
   - API_PORT → port to listen on (default 3000)
   - API_SECRET → a long random string (the mod must send this in every request)

2. Install dependencies:
   npm install

3. Start the server:
   npm start

## Endpoints

All endpoints require the header:  X-API-Secret: <your secret>

GET /health          → confirms the server and DB are reachable
GET /members         → returns all active empire members
GET /member/:username → look up a single player by Minecraft username
