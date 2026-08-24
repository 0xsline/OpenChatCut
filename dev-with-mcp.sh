#!/bin/sh
# 本地启动 OpenChatCut（MCP token 由服务端持久化机制管理，重启不变）
# 用法: ./dev-with-mcp.sh
exec npm run dev:isolated
