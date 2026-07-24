# Sera MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for **Sera** — the stablecoin exchange platform. Enables AI assistants like Claude to query market data, check balances, execute swaps, and manage orders through natural language.

## Features

- **Market Data** — Real-time stablecoin prices, metadata, and historical data
- **Wallet Management** — Check balances, token holdings, and exchange deposits
- **Trading** — Get quotes and execute swaps with automatic token approval
- **Order Management** — Place, view, and cancel limit orders
- **Deposit & Withdraw** — Move funds between wallet and exchange
- **Multi-Network** — Supports Ethereum mainnet and Sepolia testnet

## Quick Start

```bash
cd sera-mcp
npm install
npm run build
```

Then add the server to your Claude Desktop config. See [`claude_desktop_config.example.json`](./claude_desktop_config.example.json):

```json
{
  "mcpServers": {
    "sera": {
      "command": "node",
      "args": ["/path/to/sera-mcp/dist/index.js"],
      "env": {
        "EXTERNAL_API_URL": "https://api.dev.sera.cx",
        "WALLET_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
        "RPC_URL": "https://ethereum-sepolia-rpc.publicnode.com"
      }
    }
  }
}
```

Config file location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop after editing the config.

### Mainnet Configuration

```json
{
  "env": {
    "EXTERNAL_API_URL": "https://api.sera.cx",
    "WALLET_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
    "RPC_URL": "https://eth.llamarpc.com"
  }
}
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `EXTERNAL_API_URL` | CLOB/trading API URL | `https://api.dev.sera.cx` |
| `WALLET_PRIVATE_KEY` | Private key for signing transactions (optional, enables execute tools) | - |
| `RPC_URL` | Ethereum RPC endpoint | `https://ethereum-sepolia-rpc.publicnode.com` |

**⚠️ Security Warning**: Never share or commit your `WALLET_PRIVATE_KEY`. Use a dedicated wallet for testing with limited funds.

## Available Tools

### Market Data

| Tool | Description |
|------|-------------|
| `get_market` | Get the complete stablecoin catalogue with live market data |
| `get_coin_metadata` | Get detailed metadata for a specific coin by ticker |
| `get_coin_history` | Get historical price data for a specific coin |
| `search_coins` | Search for stablecoins by name or ticker |
| `get_exchange_rate` | Get the exchange rate between two tokens |

### Wallet & Balance

| Tool | Description |
|------|-------------|
| `get_wallet_info` | Get configured wallet address, balance, and chain |
| `get_wallet_balances` | Get token balances (defaults to configured wallet) |
| `get_exchange_balance` | Get exchange (vault) balance (defaults to configured wallet) |

### Trading

| Tool | Description |
|------|-------------|
| `get_trading_pairs` | Get available trading pairs for a token |
| `get_swap_quote` | Get a price quote for swapping tokens |
| `get_clob_swap_quote` | Get a CLOB exchange swap quote |
| `prepare_swap` | Prepare a swap transaction (returns tx data to sign) |
| `execute_swap` | **Execute a swap end-to-end**: quote, approve if needed, sign EIP-712 intent, submit. Requires `WALLET_PRIVATE_KEY`. |

### Order Management

| Tool | Description |
|------|-------------|
| `place_limit_order` | Place a limit order |
| `get_open_orders` | Get all open orders (defaults to configured wallet) |
| `cancel_order` | Cancel an open order |

### Deposit & Withdraw

| Tool | Description |
|------|-------------|
| `prepare_deposit` | Prepare a deposit transaction (returns tx data to sign) |
| `prepare_withdraw` | Prepare a withdrawal transaction (returns tx data to sign) |
| `execute_deposit` | **Execute a deposit end-to-end**: builds tx, signs, sends on-chain. Requires `WALLET_PRIVATE_KEY`. |
| `execute_withdraw` | **Execute a withdrawal end-to-end**: builds tx, signs, sends on-chain. Requires `WALLET_PRIVATE_KEY`. |

## Example Prompts

Once configured, you can interact with Sera using natural language:

| Prompt | What it does |
|--------|-------------|
| "Check my wallet balances" | Calls `get_wallet_info` + `get_wallet_balances` |
| "Show me all stablecoins on Sera" | Calls `get_market` |
| "What's the exchange rate between USDT and USDC?" | Calls `get_exchange_rate` |
| "Swap 100 USDT for USDC" | Calls `execute_swap` with auto-approval |
| "Deposit 50 USDT to my exchange balance" | Calls `execute_deposit` |
| "Show my open orders and cancel the first one" | Calls `get_open_orders` + `cancel_order` |

## Key Behaviors

1. **Human-readable amounts**: All amount inputs (swap, deposit, withdraw) accept human-readable values like `"100"`. The server automatically converts to raw units (e.g., `100000000` for 6-decimal tokens) using token decimals fetched from the API.

2. **Automatic token approval**: `execute_swap` automatically checks if the input token has sufficient allowance for the SOR contract. If not (e.g., USDT which doesn't support EIP-2612 permit), it sends an on-chain `approve(spender, maxUint256)` transaction, waits for confirmation, refreshes the quote, then proceeds with the swap.

3. **EIP-712 signing**: Swap intents are signed using EIP-712 typed data (`Intent` type) with the Sera domain. The `uuid` field in `route_params` is a decimal big integer, not a UUID string.

4. **Authenticated endpoints**: `get_wallet_balances`, `get_open_orders`, and `get_exchange_balance` default to the configured wallet address. If a different `wallet_address` is provided, they return an info message instead of failing with 403.

5. **No-liquidity handling**: When the API returns a `no_liquidity` error (HTTP 400), the server returns a structured `{ status: "no_liquidity" }` response instead of a generic error.

6. **Testnet vs Mainnet**: Use `EXTERNAL_API_URL=https://api.dev.sera.cx` for testnet (Sepolia) or `https://api.sera.cx` for mainnet. The RPC URL must match the chain.

| Network | API URL | Chain ID | Example RPC |
|---------|---------|----------|-------------|
| Mainnet | `https://api.sera.cx` | 1 | `https://eth.llamarpc.com` |
| Sepolia | `https://api.dev.sera.cx` | 11155111 | `https://ethereum-sepolia-rpc.publicnode.com` |

## Development

```bash
# Run in dev mode with hot reload
EXTERNAL_API_URL=https://api.dev.sera.cx \
WALLET_PRIVATE_KEY=0x... \
npm run dev
```

## License

MIT

---

Built for [Sera](https://sera.cx) 🌐
