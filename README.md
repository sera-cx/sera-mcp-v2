# Sera MCP Server

A Model Context Protocol (MCP) server that provides comprehensive access to Sera's stablecoin exchange platform, including market data, wallet operations, trading, and order management.

The server talks **directly** to the Sera CLOB API — no webapp backend required. When `WALLET_PRIVATE_KEY` is set, it can also sign and send on-chain transactions (swaps, deposits, withdrawals, token approvals).

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

## Tool Examples

### Market Data

```json
// Get all stablecoins
{ "page": 1, "per_page": 10 }

// Search by name
{ "query": "tether", "limit": 5 }

// Get coin metadata by ticker
{ "ticker": "USDT" }
```

### Trading

```json
// Get a swap quote
{
  "market_id": "0x8365421d0e1b316fc6398d21be162992216bf2ad-0x965d4b4546716e416e950bc30467d128455d2d0e",
  "direction": "ASK",
  "amount_in": "100"
}

// Execute a swap (100 USDT to USDC, amounts are human-readable)
{
  "from_token": "0x8365421d0e1b316fc6398d21be162992216bf2ad",
  "to_token": "0x965d4b4546716e416e950bc30467d128455d2d0e",
  "amount": "100"
}
```

### Deposit & Withdraw

```json
// Execute a deposit (100 USDT to exchange balance)
{
  "token_address": "0x8365421d0e1b316fc6398d21be162992216bf2ad",
  "amount": "100"
}

// Execute a withdrawal
{
  "token_address": "0x8365421d0e1b316fc6398d21be162992216bf2ad",
  "amount": "50"
}
```

## Key Behaviors

1. **Human-readable amounts**: All amount inputs (swap, deposit, withdraw) accept human-readable values like `"100"`. The server automatically converts to raw units (e.g., `100000000` for 6-decimal tokens) using token decimals fetched from the API.

2. **Automatic token approval**: `execute_swap` automatically checks if the input token has sufficient allowance for the SOR contract. If not (e.g., USDT which doesn't support EIP-2612 permit), it sends an on-chain `approve(spender, maxUint256)` transaction, waits for confirmation, refreshes the quote, then proceeds with the swap.

3. **EIP-712 signing**: Swap intents are signed using EIP-712 typed data (`Intent` type) with the Sera domain. The `uuid` field in `route_params` is a decimal big integer, not a UUID string.

4. **Authenticated endpoints**: `get_wallet_balances`, `get_open_orders`, and `get_exchange_balance` default to the configured wallet address. If a different `wallet_address` is provided, they return an info message instead of failing with 403.

5. **No-liquidity handling**: When the API returns a `no_liquidity` error (HTTP 400), the server returns a structured `{ status: "no_liquidity" }` response instead of a generic error.

6. **Testnet vs Mainnet**: Use `EXTERNAL_API_URL=https://api.dev.sera.cx` for testnet (Sepolia) or `https://api.sera.cx` for mainnet. The RPC URL must match the chain.

## Development

```bash
# Run in dev mode with hot reload
EXTERNAL_API_URL=https://api.dev.sera.cx \
WALLET_PRIVATE_KEY=0x... \
npm run dev
```

## License

MIT
