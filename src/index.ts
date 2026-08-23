#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatUnits,
  encodeFunctionData,
  maxUint256,
  erc20Abi,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import { sepolia, mainnet } from "viem/chains";

// ============================================================================
// Types - Market Data
// ============================================================================

interface MarketCoin {
  ticker: string;
  name: string;
  image: string | null;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  price_change_24h: number | null;
  price_change_percentage_24h: number | null;
  slug: string | null;
  coingecko_id: string | null;
}

interface CoinMetadata {
  ticker: string;
  name: string;
  description: string | null;
  image: string | null;
  peg_currency: string | null;
  backing_type: string | null;
  continent: string | null;
  blockchains: string[];
  platforms: Record<string, string>;
  regulatory_status: string | null;
  issuer: string | null;
  founded_year: number | null;
  headquarters: string | null;
  links: {
    homepage: string | null;
    twitter: string | null;
    telegram: string | null;
    whitepaper: string | null;
  };
  slug: string | null;
  coingecko_id: string | null;
}

interface HistoryResponse {
  ticker: string;
  prices: [number, number][];
}

// ============================================================================
// Types - Trading & Wallet
// ============================================================================

interface TokenBalance {
  ticker: string;
  address: string;
  raw: string;
  decimals: number;
  balance: number;
  countryCode?: string;
  countryName?: string;
}

interface BalancesResponse {
  totalTokens: number;
  totalBalance: number;
  tokens: TokenBalance[];
}

interface MarketOption {
  direction: "ASK" | "BID";
  marketId: string;
  marketAddress: string;
  latestPrice: string;
  fromToken: {
    address: string;
    symbol: string;
    decimals: number;
    countryName?: string;
  };
  toToken: {
    address: string;
    symbol: string;
    decimals: number;
    countryName?: string;
  };
}

interface QuoteResponse {
  amountOut: string;
  rate: number;
  feeBps: number;
  feeAmount: string;
  slippage: number;
  updatedAt: string;
}

interface SwapPrepareResponse {
  status: "approval_needed" | "ready_to_swap";
  to: string;
  data: string;
  value: string;
  meta?: {
    direction: string;
    marketAddress: string;
    fromToken: string;
    toToken: string;
    amountIn: string;
    amountInRaw: string;
    decimals: number;
  };
  required?: {
    amountIn: string;
    amountInRaw: string;
  };
}

interface ClobSwapQuote {
  uuid: string;
  route_params: {
    inputToken: string;
    outputToken: string;
    maxInputAmount: string;
    minOutputAmount: string;
    recipient: string;
    initialDepositAmount: string;
    uuid: string;
    deadline: string;
  };
  fee_breakdown: Record<string, unknown>;
  expires_at: number;
  no_liquidity?: boolean;
  permit?: {
    permit_supported: boolean;
    permit_required: boolean;
    spender?: string;
    nonce?: string | number;
    current_allowance_raw?: string;
    value?: string;
    value_raw?: string;
    suggested_deadline?: string | number;
    domain?: {
      name: string;
      version: string;
      chainId: string | number;
      verifyingContract: string;
    };
  };
}

interface OrderSubmitResponse {
  client_id?: string;
  order_id?: string;
  error?: string;
}

// ============================================================================
// Configuration
// ============================================================================

// EXTERNAL_API_URL - the CLOB/trading API (e.g., https://api.dev.sera.cx)
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL || process.env.NEXT_PUBLIC_EXTERNAL_API_URL || "https://api.dev.sera.cx";

// Wallet configuration
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || "";
const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

// Determine chain based on API URL
const isMainnet = EXTERNAL_API_URL.includes("api.sera.cx") && !EXTERNAL_API_URL.includes("dev");
const chain = isMainnet ? mainnet : sepolia;

// Create wallet client if private key is provided
let walletClient: ReturnType<typeof createWalletClient> | null = null;
let publicClient: ReturnType<typeof createPublicClient> | null = null;
let walletAddress: `0x${string}` | null = null;
let walletAccount: ReturnType<typeof privateKeyToAccount> | null = null;

// Cached bearer token for authenticated API calls
let cachedBearerToken: string | null = null;
let tokenExpiresAt: number = 0;

if (WALLET_PRIVATE_KEY) {
  try {
    walletAccount = privateKeyToAccount(WALLET_PRIVATE_KEY as `0x${string}`);
    walletAddress = walletAccount.address;
    
    walletClient = createWalletClient({
      account: walletAccount,
      chain,
      transport: http(RPC_URL),
    });
    
    publicClient = createPublicClient({
      chain,
      transport: http(RPC_URL),
    });
  } catch (e) {
    console.error("Failed to initialize wallet:", e);
  }
}

// EIP-712 domain for Sera CLOB API key signing
const SERA_EIP712_DOMAIN = {
  name: "Sera",
  version: "1",
  chainId: isMainnet ? 1 : 11155111,
  verifyingContract: (isMainnet
    ? "0xB5C50C5D5f038404F85970b7f5B7259C4AC0E198"
    : "0x63c8e50c04c278d3574b2468c72e470df866efd2") as `0x${string}`,
};

const MANAGE_API_KEY_TYPES = {
  ManageApiKey: [
    { name: "owner", type: "address" },
    { name: "action", type: "string" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

// Get or create bearer token for authenticated API calls
async function getBearerToken(): Promise<string | null> {
  if (!walletAccount || !walletAddress) return null;
  
  // Return cached token if still valid (with 5 min buffer)
  if (cachedBearerToken && Date.now() < tokenExpiresAt - 300000) {
    return cachedBearerToken;
  }
  
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const ownerAddress = walletAddress.toLowerCase() as `0x${string}`;
    
    // Sign EIP-712 typed data for API key creation
    const signature = await signTypedData({
      privateKey: WALLET_PRIVATE_KEY as `0x${string}`,
      domain: SERA_EIP712_DOMAIN,
      types: MANAGE_API_KEY_TYPES,
      primaryType: "ManageApiKey",
      message: {
        owner: ownerAddress,
        action: "create",
        timestamp: BigInt(timestamp),
      },
    });
    
    const response = await fetch(`${EXTERNAL_API_URL}/api/v1/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_address: ownerAddress,
        action: "create",
        timestamp,
        signature,
        label: "sera-mcp",
      }),
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error("Failed to create API key:", response.status, errText);
      return null;
    }
    
    const data = await response.json() as { 
      api_key: string; 
      api_secret: string;
      expires_at?: string;
      duration_seconds?: number;
    };
    
    // Bearer token is api_key:api_secret
    cachedBearerToken = `${data.api_key}:${data.api_secret}`;
    
    // Parse expiry
    if (data.expires_at) {
      tokenExpiresAt = new Date(data.expires_at).getTime();
    } else if (data.duration_seconds) {
      tokenExpiresAt = Date.now() + data.duration_seconds * 1000;
    } else {
      tokenExpiresAt = Date.now() + 86400000; // 24 hours default
    }
    
    return cachedBearerToken;
  } catch (e) {
    console.error("Failed to get bearer token:", e);
    return null;
  }
}

// ============================================================================
// API Client - Direct CLOB API calls with robust error handling
// ============================================================================

const API_TIMEOUT_MS = 60000; // 60 seconds timeout

class ClobApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string
  ) {
    super(message || `CLOB API error ${status}`);
    this.name = "ClobApiError";
  }
}

function formatApiError(error: unknown): string {
  if (error instanceof ClobApiError) {
    const body = error.body;
    if (typeof body === "string") {
      return `API Error ${error.status}: ${body}`;
    }
    if (typeof body === "object" && body !== null) {
      const obj = body as Record<string, unknown>;
      // Try common error fields, handling nested detail objects
      const msg = obj.message || obj.error || obj.detail;
      if (typeof msg === "string") {
        return `API Error ${error.status}: ${msg}`;
      }
      if (typeof msg === "object" && msg !== null) {
        const detailObj = msg as Record<string, unknown>;
        const innerMsg = detailObj.message || detailObj.error || detailObj.detail;
        if (typeof innerMsg === "string") {
          return `API Error ${error.status}: ${innerMsg}`;
        }
      }
      // Fall back to JSON stringification
      try {
        return `API Error ${error.status}: ${JSON.stringify(body)}`;
      } catch {
        return `API Error ${error.status}: [unparseable response]`;
      }
    }
    return `API Error ${error.status}: ${String(body)}`;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Request timeout - API took too long to respond";
    return error.message;
  }
  return String(error);
}

// Check if an error or error string indicates no liquidity
function isNoLiquidityError(error: unknown): boolean {
  if (error instanceof ClobApiError) {
    if (error.status !== 400) return false;
    const body = error.body as Record<string, unknown>;
    const detail = body?.detail;
    if (typeof detail === "object" && detail !== null) {
      const detailObj = detail as Record<string, unknown>;
      const errVal = detailObj.error || detailObj.code || detailObj.message;
      if (typeof errVal === "string" && errVal.toLowerCase().includes("no_liquidity")) {
        return true;
      }
    }
    if (typeof detail === "string" && detail.toLowerCase().includes("no_liquidity")) {
      return true;
    }
  }
  // Also check string form (from safeClobRequest error messages)
  if (typeof error === "string" && error.toLowerCase().includes("no_liquidity")) {
    return true;
  }
  return false;
}

async function clobRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    requiresAuth?: boolean;
  } = {}
): Promise<T> {
  const { method = "GET", body, params, requiresAuth = false } = options;

  let url = `${EXTERNAL_API_URL}/api/v1${path}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Add bearer token for authenticated requests
  if (requiresAuth) {
    const token = await getBearerToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      throw new ClobApiError(401, { detail: "Authentication required but WALLET_PRIVATE_KEY is not set or API key creation failed. Set WALLET_PRIVATE_KEY environment variable to enable authenticated endpoints like balances and orders." });
    }
  }

  // Add timeout using AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const ct = res.headers.get("content-type") || "";
    let payload: unknown;
    
    try {
      payload = ct.includes("application/json") ? await res.json() : await res.text();
    } catch {
      payload = "Failed to parse response";
    }

    if (!res.ok) {
      throw new ClobApiError(res.status, payload);
    }

    return payload as T;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Safe wrapper that returns result or error message
async function safeClobRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    requiresAuth?: boolean;
  } = {}
): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    const data = await clobRequest<T>(path, options);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: formatApiError(error) };
  }
}

// ============================================================================
// Wallet Helper Functions
// ============================================================================

// Fetch decimals for a token from the /markets endpoint
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const result = await safeClobRequest<{ markets: ClobMarketRaw[] }>("/markets");
  if (!result.success) return 6;
  const token = tokenAddress.toLowerCase();
  const market = result.data.markets?.find(
    (m) => m.base_address.toLowerCase() === token || m.quote_address.toLowerCase() === token
  );
  if (!market) return 6;
  return market.base_address.toLowerCase() === token
    ? market.base_decimals
    : market.quote_decimals;
}

// Convert human-readable amount string to raw units string
// e.g., "100" with 6 decimals -> "100000000"
function toRawAmount(humanAmount: string, decimals: number): string {
  const floatAmount = parseFloat(humanAmount);
  if (isNaN(floatAmount) || floatAmount <= 0) {
    throw new Error(`Invalid amount: ${humanAmount}. Must be a positive number.`);
  }
  return BigInt(Math.floor(floatAmount * Math.pow(10, decimals))).toString();
}

// Convert raw units string to human-readable number
// e.g., "100000000" with 6 decimals -> 100
function fromRawAmount(rawAmount: string, decimals: number): number {
  try {
    return Number(BigInt(rawAmount)) / Math.pow(10, decimals);
  } catch {
    return 0;
  }
}

async function sendTransaction(tx: {
  to: string;
  data: string;
  value?: string;
}): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  if (!walletClient || !publicClient || !walletAddress) {
    throw new Error("Wallet not configured. Set WALLET_PRIVATE_KEY environment variable.");
  }

  const account = privateKeyToAccount(WALLET_PRIVATE_KEY as `0x${string}`);
  
  const hash = await walletClient.sendTransaction({
    account,
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: tx.value ? BigInt(tx.value) : 0n,
    chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}

async function getWalletInfo(): Promise<{
  address: string;
  balance: string;
  chain: string;
}> {
  if (!walletAddress || !publicClient) {
    throw new Error("Wallet not configured");
  }

  const balance = await publicClient.getBalance({ address: walletAddress });
  return {
    address: walletAddress,
    balance: formatUnits(balance, 18),
    chain: chain.name,
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

const tools: Tool[] = [
  // -------------------------------------------------------------------------
  // Market Data Tools
  // -------------------------------------------------------------------------
  {
    name: "get_market",
    description:
      "Get Sera's complete stablecoin catalogue with live market data including price, market cap, volume, and 24h changes. Supports pagination.",
    inputSchema: {
      type: "object" as const,
      properties: {
        page: {
          type: "number",
          description: "Page number (1-based). Default: 1",
        },
        per_page: {
          type: "number",
          description: "Number of results per page (1-500). Default: 250",
        },
      },
    },
  },
  {
    name: "get_coin_metadata",
    description:
      "Get detailed metadata for a specific stablecoin including description, blockchains, platforms, regulatory info, issuer details, and social links.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "The coin ticker symbol (e.g., USDT, USDC). Case-insensitive.",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "get_coin_history",
    description:
      "Get historical price data for a specific stablecoin. Returns timestamp and price pairs suitable for sparklines or charts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "The coin ticker symbol (e.g., USDT, USDC). Case-insensitive.",
        },
        days: {
          type: "number",
          description: "Number of days of history (1-365). Default: 7",
        },
      },
      required: ["ticker"],
    },
  },
  {
    name: "search_coins",
    description:
      "Search for stablecoins by name or ticker. Returns matching coins from the catalogue.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query to match against coin name or ticker",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Default: 10",
        },
      },
      required: ["query"],
    },
  },

  // -------------------------------------------------------------------------
  // Wallet & Balance Tools
  // -------------------------------------------------------------------------
  {
    name: "get_wallet_balances",
    description:
      "Get token balances for the configured wallet. Returns all stablecoin holdings with amounts and metadata. Uses the wallet address from WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet_address: {
          type: "string",
          description: "Optional. If omitted, uses the configured wallet address from WALLET_PRIVATE_KEY. The API only allows querying your own balances.",
        },
        page: {
          type: "number",
          description: "Page number. Default: 1",
        },
        page_size: {
          type: "number",
          description: "Results per page. Default: 20, Max: 200",
        },
      },
      required: [],
    },
  },

  // -------------------------------------------------------------------------
  // Trading Tools
  // -------------------------------------------------------------------------
  {
    name: "get_trading_pairs",
    description:
      "Get available trading pairs/markets for a specific token. Returns all pairs where the token can be swapped.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_address: {
          type: "string",
          description: "Token contract address to find trading pairs for",
        },
      },
      required: ["token_address"],
    },
  },
  {
    name: "get_swap_quote",
    description:
      "Get a price quote for swapping between two tokens. Returns expected output amount, rate, and fees.",
    inputSchema: {
      type: "object" as const,
      properties: {
        market_id: {
          type: "string",
          description: "Market ID (format: baseAddress-quoteAddress)",
        },
        direction: {
          type: "string",
          enum: ["ASK", "BID"],
          description: "ASK = sell base token, BID = buy base token",
        },
        amount_in: {
          type: "string",
          description: "Amount to swap (human-readable, e.g., '100.5')",
        },
      },
      required: ["market_id", "direction", "amount_in"],
    },
  },
  {
    name: "prepare_swap",
    description:
      "Prepare a swap transaction. Returns transaction data that needs to be signed and sent. May return approval_needed if token allowance is insufficient.",
    inputSchema: {
      type: "object" as const,
      properties: {
        market_address: {
          type: "string",
          description: "Market contract address",
        },
        from_token: {
          type: "string",
          description: "Source token address",
        },
        to_token: {
          type: "string",
          description: "Destination token address",
        },
        direction: {
          type: "string",
          enum: ["ASK", "BID"],
          description: "Trade direction",
        },
        amount_in: {
          type: "string",
          description: "Amount to swap (human-readable)",
        },
        user_address: {
          type: "string",
          description: "User's wallet address",
        },
      },
      required: ["market_address", "from_token", "to_token", "direction", "amount_in", "user_address"],
    },
  },
  {
    name: "get_clob_swap_quote",
    description:
      "Get a swap quote from the CLOB exchange. Returns quote with exchange rate. Amount is in human-readable units (e.g., '100' for 100 USDT).",
    inputSchema: {
      type: "object" as const,
      properties: {
        from_token: {
          type: "string",
          description: "Source token address",
        },
        to_token: {
          type: "string",
          description: "Destination token address",
        },
        from_amount: {
          type: "string",
          description: "Amount to swap in human-readable units (e.g., '100' for 100 USDT). Will be automatically converted to raw units.",
        },
        owner_address: {
          type: "string",
          description: "Optional. Wallet address for the swap. If omitted, uses the configured wallet address.",
        },
      },
      required: ["from_token", "to_token", "from_amount"],
    },
  },
  {
    name: "get_exchange_rate",
    description:
      "Get the exchange rate between two tokens. Returns the rate for swapping 1 unit of from_token to to_token.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from_token: {
          type: "string",
          description: "Source token address",
        },
        to_token: {
          type: "string",
          description: "Destination token address",
        },
        from_decimals: {
          type: "number",
          description: "Optional. Decimals of the source token. Looked up from the token registry if omitted.",
        },
        to_decimals: {
          type: "number",
          description: "Optional. Decimals of the destination token. Looked up from the token registry if omitted.",
        },
      },
      required: ["from_token", "to_token"],
    },
  },

  // -------------------------------------------------------------------------
  // Order Management Tools
  // -------------------------------------------------------------------------
  {
    name: "place_limit_order",
    description:
      "Place a limit order (set your own rate). Creates an order that will be filled when the market reaches your price.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from_token: {
          type: "string",
          description: "Token you are selling",
        },
        to_token: {
          type: "string",
          description: "Token you want to receive",
        },
        amount: {
          type: "string",
          description: "Amount to sell (human-readable)",
        },
        price: {
          type: "string",
          description: "Your desired exchange rate",
        },
        owner_address: {
          type: "string",
          description: "Your wallet address",
        },
      },
      required: ["from_token", "to_token", "amount", "price", "owner_address"],
    },
  },
  {
    name: "get_open_orders",
    description:
      "Get all open/pending orders for the configured wallet. Uses the wallet address from WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet_address: {
          type: "string",
          description: "Optional. If omitted, uses the configured wallet address from WALLET_PRIVATE_KEY.",
        },
      },
      required: [],
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel an open order by its order ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        order_id: {
          type: "string",
          description: "The order ID to cancel",
        },
        owner_address: {
          type: "string",
          description: "Wallet address that owns the order",
        },
      },
      required: ["order_id", "owner_address"],
    },
  },

  // -------------------------------------------------------------------------
  // Deposit & Withdraw Tools
  // -------------------------------------------------------------------------
  {
    name: "get_exchange_balance",
    description:
      "Get the exchange (vault) balance for the configured wallet. Uses the wallet address from WALLET_PRIVATE_KEY. This is separate from wallet balance - funds deposited into the exchange for trading.",
    inputSchema: {
      type: "object" as const,
      properties: {
        wallet_address: {
          type: "string",
          description: "Optional. If omitted, uses the configured wallet address from WALLET_PRIVATE_KEY.",
        },
      },
      required: [],
    },
  },
  {
    name: "prepare_deposit",
    description:
      "Prepare a deposit transaction to move funds from wallet to exchange balance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_address: {
          type: "string",
          description: "Token to deposit",
        },
        amount: {
          type: "string",
          description: "Amount to deposit (human-readable)",
        },
        owner_address: {
          type: "string",
          description: "Wallet address",
        },
      },
      required: ["token_address", "amount", "owner_address"],
    },
  },
  {
    name: "prepare_withdraw",
    description:
      "Prepare a withdrawal transaction to move funds from exchange balance back to wallet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_address: {
          type: "string",
          description: "Token to withdraw",
        },
        amount: {
          type: "string",
          description: "Amount to withdraw (human-readable)",
        },
        owner_address: {
          type: "string",
          description: "Wallet address",
        },
      },
      required: ["token_address", "amount", "owner_address"],
    },
  },
  // -------------------------------------------------------------------------
  // Wallet Tools (requires WALLET_PRIVATE_KEY)
  // -------------------------------------------------------------------------
  {
    name: "get_wallet_info",
    description:
      "Get information about the configured wallet (address, balance, chain). Requires WALLET_PRIVATE_KEY to be set.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "execute_swap",
    description:
      "Execute a swap transaction. Gets a quote, handles token approval if needed (sends on-chain approve tx for non-permit tokens like USDT), signs the EIP-712 intent, and submits. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from_token: {
          type: "string",
          description: "Address of token to sell",
        },
        to_token: {
          type: "string",
          description: "Address of token to buy",
        },
        amount: {
          type: "string",
          description: "Amount to swap (in token units, e.g., '100' for 100 tokens)",
        },
      },
      required: ["from_token", "to_token", "amount"],
    },
  },
  {
    name: "execute_deposit",
    description:
      "Execute a deposit to move funds from wallet to exchange. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_address: {
          type: "string",
          description: "Token to deposit",
        },
        amount: {
          type: "string",
          description: "Amount to deposit (human-readable, e.g., '100' for 100 tokens)",
        },
      },
      required: ["token_address", "amount"],
    },
  },
  {
    name: "execute_withdraw",
    description:
      "Execute a withdrawal to move funds from exchange back to wallet. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_address: {
          type: "string",
          description: "Token to withdraw",
        },
        amount: {
          type: "string",
          description: "Amount to withdraw (human-readable, e.g., '100' for 100 tokens)",
        },
      },
      required: ["token_address", "amount"],
    },
  },
];

// ============================================================================
// CLOB API Response Types
// ============================================================================

interface ClobToken {
  address: string;
  symbol: string;
  currency: string;
  decimals: number;
}

interface ClobMarketRaw {
  symbol: string;
  base_symbol?: string;
  quote_symbol?: string;
  base_address: string;
  quote_address: string;
  base_decimals: number;
  quote_decimals: number;
}

interface ClobBalanceItem {
  symbol: string;
  token: string;
  decimals?: number;
  wallet_balance?: string;
  wallet_balance_owner?: string;
  vault_available?: string;
  vault_total?: string;
}

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleGetMarket(_args: { page?: number; per_page?: number }): Promise<string> {
  // Get tokens list from CLOB API
  const response = await clobRequest<{ tokens: ClobToken[] }>("/tokens");
  const tokens = response.tokens || [];

  return JSON.stringify(
    {
      total: tokens.length,
      tokens: tokens.map((t) => ({
        symbol: t.symbol,
        address: t.address,
        currency: t.currency,
        decimals: t.decimals,
      })),
    },
    null,
    2
  );
}

async function handleGetCoinMetadata(args: { ticker: string }): Promise<string> {
  const result = await safeClobRequest<{ tokens: ClobToken[] }>("/tokens");
  
  if (!result.success) {
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }

  const token = result.data.tokens?.find(
    (t) => t.symbol.toUpperCase() === args.ticker.toUpperCase()
  );

  if (!token) {
    return JSON.stringify(
      { 
        status: "not_found", 
        message: `Token ${args.ticker} not found`,
        suggestion: "Use search_coins to find available tokens"
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      status: "success",
      ticker: token.symbol,
      address: token.address,
      currency: token.currency,
      decimals: token.decimals,
    },
    null,
    2
  );
}

async function handleGetCoinHistory(_args: { ticker: string; days?: number }): Promise<string> {
  return JSON.stringify(
    {
      message: "Historical price data not available via CLOB API",
      suggestion: "Use get_swap_quote to get current exchange rates",
    },
    null,
    2
  );
}

async function handleSearchCoins(args: { query: string; limit?: number }): Promise<string> {
  const result = await safeClobRequest<{ tokens: ClobToken[] }>("/tokens");
  
  if (!result.success) {
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }
  
  const tokens = result.data.tokens || [];

  const query = args.query.toLowerCase();
  const limit = args.limit || 10;

  const matches = tokens
    .filter(
      (t) =>
        t.symbol.toLowerCase().includes(query) ||
        t.currency.toLowerCase().includes(query)
    )
    .slice(0, limit);

  return JSON.stringify(
    {
      query: args.query,
      matches_found: matches.length,
      results: matches.map((t) => ({
        symbol: t.symbol,
        address: t.address,
        currency: t.currency,
        decimals: t.decimals,
      })),
    },
    null,
    2
  );
}

// ============================================================================
// Wallet & Balance Handlers
// ============================================================================

async function handleGetWalletBalances(args: {
  wallet_address?: string;
  page?: number;
  page_size?: number;
}): Promise<string> {
  // Use the wallet's own address (from private key) — API only allows querying own balances
  const ownerAddress = walletAddress || args.wallet_address;
  if (!ownerAddress || !ownerAddress.startsWith("0x")) {
    return JSON.stringify(
      { status: "error", message: "No wallet address available. Set WALLET_PRIVATE_KEY to enable balance queries." },
      null,
      2
    );
  }

  // Warn if user provided a different address than the wallet's own
  if (args.wallet_address && args.wallet_address.toLowerCase() !== ownerAddress.toLowerCase()) {
    return JSON.stringify(
      {
        status: "info",
        message: `The API only allows querying your own balances. Your configured wallet address is ${ownerAddress}. Please use get_wallet_balances without specifying a different address, or use your own address: ${ownerAddress}`,
        configured_wallet: ownerAddress,
        requested_wallet: args.wallet_address,
      },
      null,
      2
    );
  }

  const result = await safeClobRequest<{ balances: ClobBalanceItem[] }>("/balances", {
    params: { owner_address: ownerAddress.toLowerCase() },
    requiresAuth: true,
  });

  if (!result.success) {
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }

  const items = result.data.balances || [];
  const nonZero = items.filter((b) => {
    try {
      const walletBal = b.wallet_balance_owner || b.wallet_balance || "0";
      return BigInt(walletBal) > 0n;
    } catch {
      return false;
    }
  });

  return JSON.stringify(
    {
      status: "success",
      wallet: args.wallet_address,
      total_tokens: items.length,
      tokens_with_balance: nonZero.length,
      balances: nonZero.map((b) => ({
        symbol: b.symbol,
        address: b.token,
        wallet_balance: b.wallet_balance_owner || b.wallet_balance || "0",
        decimals: b.decimals,
      })),
    },
    null,
    2
  );
}

// ============================================================================
// Trading Handlers
// ============================================================================

async function handleGetTradingPairs(args: { token_address: string }): Promise<string> {
  // Validate token address
  if (!args.token_address || !args.token_address.startsWith("0x")) {
    return JSON.stringify(
      { status: "error", message: "Invalid token address. Must start with 0x" },
      null,
      2
    );
  }

  const result = await safeClobRequest<{ markets: ClobMarketRaw[] }>("/markets");
  
  if (!result.success) {
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }
  
  const markets = result.data.markets || [];

  const fromAddress = args.token_address.toLowerCase();
  const matchingMarkets = markets.filter(
    (m) =>
      m.base_address.toLowerCase() === fromAddress ||
      m.quote_address.toLowerCase() === fromAddress
  );

  return JSON.stringify(
    {
      token: args.token_address,
      pairs_count: matchingMarkets.length,
      pairs: matchingMarkets.map((m) => {
        const isFromBase = m.base_address.toLowerCase() === fromAddress;
        return {
          symbol: m.symbol,
          direction: isFromBase ? "ASK" : "BID",
          from: {
            symbol: isFromBase ? m.base_symbol : m.quote_symbol,
            address: isFromBase ? m.base_address : m.quote_address,
          },
          to: {
            symbol: isFromBase ? m.quote_symbol : m.base_symbol,
            address: isFromBase ? m.quote_address : m.base_address,
          },
        };
      }),
    },
    null,
    2
  );
}

async function handleGetSwapQuote(args: {
  market_id: string;
  direction: "ASK" | "BID";
  amount_in: string;
}): Promise<string> {
  // Parse market_id to get token addresses (format: baseAddress-quoteAddress)
  const [baseAddress, quoteAddress] = args.market_id.split("-");

  if (!baseAddress || !quoteAddress) {
    return JSON.stringify(
      { 
        status: "error", 
        message: "Invalid market_id format. Expected: baseAddress-quoteAddress",
        example: "0xTokenA-0xTokenB"
      },
      null,
      2
    );
  }

  const fromToken = args.direction === "ASK" ? baseAddress : quoteAddress;
  const toToken = args.direction === "ASK" ? quoteAddress : baseAddress;

  // Convert human-readable amount to raw units
  const fromDecimals = await getTokenDecimals(fromToken);
  let rawAmount: string;
  try {
    rawAmount = toRawAmount(args.amount_in, fromDecimals);
  } catch (e) {
    return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
  }

  // Use a placeholder valid address (not zero address)
  const placeholderAddr = walletAddress || "0x0000000000000000000000000000000000000001";

  const result = await safeClobRequest<ClobSwapQuote>("/swap/quote", {
    method: "POST",
    body: {
      from_token: fromToken.toLowerCase(),
      to_token: toToken.toLowerCase(),
      from_amount: rawAmount,
      owner_address: placeholderAddr.toLowerCase(),
      recipient: placeholderAddr.toLowerCase(),
      expiration: Math.floor(Date.now() / 1000) + 3600,
    },
  });

  if (!result.success) {
    // Check if it's a no_liquidity response (API returns 400 for this)
    if (isNoLiquidityError(result.error)) {
      return JSON.stringify(
        {
          status: "no_liquidity", message: "No liquidity available for this pair" },
        null, 2
      );
    }
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }

  const quote = result.data;
  if (quote.no_liquidity) {
    return JSON.stringify({ status: "no_liquidity", message: "No liquidity available for this pair" }, null, 2);
  }

  // Calculate human-readable amounts
  const toDecimals = await getTokenDecimals(toToken);
  const inputHuman = fromRawAmount(quote.route_params?.maxInputAmount || rawAmount, fromDecimals);
  const outputHuman = fromRawAmount(quote.route_params?.minOutputAmount || "0", toDecimals);
  const rate = inputHuman > 0 ? outputHuman / inputHuman : 0;

  return JSON.stringify(
    {
      status: "quote_ready",
      quote_uuid: quote.uuid,
      input_amount: quote.route_params?.maxInputAmount,
      output_amount: quote.route_params?.minOutputAmount,
      input_amount_human: inputHuman.toFixed(6),
      output_amount_human: outputHuman.toFixed(6),
      exchange_rate: rate.toFixed(6),
      expires_at: quote.expires_at ? new Date(quote.expires_at * 1000).toISOString() : null,
    },
    null,
    2
  );
}

async function handlePrepareSwap(args: {
  market_address: string;
  from_token: string;
  to_token: string;
  direction: string;
  amount_in: string;
  user_address: string;
}): Promise<string> {
  // Convert human-readable amount to raw units
  const fromDecimals = await getTokenDecimals(args.from_token);
  let rawAmount: string;
  try {
    rawAmount = toRawAmount(args.amount_in, fromDecimals);
  } catch (e) {
    return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
  }

  const result = await safeClobRequest<ClobSwapQuote>("/swap/quote", {
    method: "POST",
    body: {
      from_token: args.from_token.toLowerCase(),
      to_token: args.to_token.toLowerCase(),
      from_amount: rawAmount,
      owner_address: args.user_address.toLowerCase(),
      recipient: args.user_address.toLowerCase(),
      expiration: Math.floor(Date.now() / 1000) + 3600,
    },
  });

  if (!result.success) {
    if (isNoLiquidityError(result.error)) {
      return JSON.stringify({ status: "no_liquidity", message: "No liquidity available for this pair" }, null, 2);
    }
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }

  const quote = result.data;
  if (quote.no_liquidity) {
    return JSON.stringify({ status: "no_liquidity", message: "No liquidity available" }, null, 2);
  }

  return JSON.stringify(
    {
      status: "quote_ready",
      message: "Swap quote ready. Sign the quote UUID to execute.",
      quote_uuid: quote.uuid,
      route_params: quote.route_params,
      expires_at: quote.expires_at ? new Date(quote.expires_at * 1000).toISOString() : null,
      instructions: [
        "1. Sign the quote UUID with your wallet",
        "2. Submit signature to /swap endpoint",
        "3. Or use Sera webapp for guided experience",
      ],
    },
    null,
    2
  );
}

async function handleGetClobSwapQuote(args: {
  from_token: string;
  to_token: string;
  from_amount: string;
  owner_address?: string;
}): Promise<string> {
  // Validate addresses
  if (!args.from_token?.startsWith("0x") || !args.to_token?.startsWith("0x")) {
    return JSON.stringify(
      { status: "error", message: "Invalid token addresses. Must start with 0x" },
      null,
      2
    );
  }

  // Default owner_address to configured wallet, or use placeholder
  const ownerAddr = (args.owner_address || walletAddress || "0x0000000000000000000000000000000000000001").toLowerCase();

  // Convert human-readable amount to raw units
  const fromDecimals = await getTokenDecimals(args.from_token);
  let rawAmount: string;
  try {
    rawAmount = toRawAmount(args.from_amount, fromDecimals);
  } catch (e) {
    return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
  }

  const result = await safeClobRequest<ClobSwapQuote>("/swap/quote", {
    method: "POST",
    body: {
      from_token: args.from_token.toLowerCase(),
      to_token: args.to_token.toLowerCase(),
      from_amount: rawAmount,
      owner_address: ownerAddr,
      recipient: ownerAddr,
      expiration: Math.floor(Date.now() / 1000) + 3600,
    },
  });

  if (!result.success) {
    if (isNoLiquidityError(result.error)) {
      return JSON.stringify(
        {
          status: "no_liquidity", message: "No liquidity available for this pair",
          input_token: args.from_token, output_token: args.to_token,
        },
        null, 2
      );
    }
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }

  const quote = result.data;
  if (quote.no_liquidity) {
    return JSON.stringify(
      {
        status: "no_liquidity",
        message: "No liquidity available for this pair",
        input_token: args.from_token,
        output_token: args.to_token,
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      status: "quote_ready",
      quote_uuid: quote.uuid,
      input_token: quote.route_params?.inputToken,
      output_token: quote.route_params?.outputToken,
      max_input: quote.route_params?.maxInputAmount,
      min_output: quote.route_params?.minOutputAmount,
      expires_at: quote.expires_at ? new Date(quote.expires_at * 1000).toISOString() : null,
      fee_breakdown: quote.fee_breakdown,
    },
    null,
    2
  );
}

async function handleGetExchangeRate(args: {
  from_token: string;
  to_token: string;
  from_decimals?: number;
  to_decimals?: number;
}): Promise<string> {
  const fromDecimals = args.from_decimals ?? (await getTokenDecimals(args.from_token));
  const toDecimals = args.to_decimals ?? (await getTokenDecimals(args.to_token));
  
  // Try progressively larger amounts to meet minimum trade requirements
  const amountsToTry = [
    10000,     // 10,000 units
    100000,    // 100,000 units  
    1000000,   // 1,000,000 units
    10000000,  // 10,000,000 units
  ];
  
  for (const amount of amountsToTry) {
    const rawAmount = BigInt(amount) * BigInt(10 ** fromDecimals);
    
    try {
      const quote = await clobRequest<ClobSwapQuote>("/swap/quote", {
        method: "POST",
        body: {
          from_token: args.from_token.toLowerCase(),
          to_token: args.to_token.toLowerCase(),
          from_amount: rawAmount.toString(),
          owner_address: "0x0000000000000000000000000000000000000001",
          recipient: "0x0000000000000000000000000000000000000001",
          expiration: Math.floor(Date.now() / 1000) + 3600,
        },
      });

      if (quote.no_liquidity) {
        return JSON.stringify(
          {
            status: "no_liquidity",
            message: "No liquidity available for this pair",
            from_token: args.from_token,
            to_token: args.to_token,
          },
          null,
          2
        );
      }

      // Calculate human-readable rate
      const inputHuman = fromRawAmount(quote.route_params?.maxInputAmount || rawAmount.toString(), fromDecimals);
      const outputHuman = fromRawAmount(quote.route_params?.minOutputAmount || "0", toDecimals);
      const rate = inputHuman > 0 ? outputHuman / inputHuman : 0;

      return JSON.stringify(
        {
          status: "success",
          from_token: args.from_token,
          to_token: args.to_token,
          rate: rate.toFixed(6),
          message: `1 from_token = ${rate.toFixed(6)} to_token`,
          sample_input: inputHuman,
          sample_output: outputHuman,
        },
        null,
        2
      );
    } catch (error) {
      // Check if it's a no_liquidity error (API returns 400)
      if (isNoLiquidityError(error)) {
        return JSON.stringify(
          {
            status: "no_liquidity",
            message: "No liquidity available for this pair",
            from_token: args.from_token,
            to_token: args.to_token,
          },
          null,
          2
        );
      }
      // Check if it's a minimum amount error
      if (error instanceof ClobApiError && error.status === 400) {
        const body = error.body as Record<string, unknown>;
        const detail = body?.detail;
        if (typeof detail === "object" && detail !== null) {
          const detailObj = detail as Record<string, unknown>;
          if (detailObj.code === "AMOUNT_BELOW_MIN") {
            // Try next larger amount
            continue;
          }
        }
      }
      // For other errors, return immediately
      const errMsg = error instanceof ClobApiError ? formatApiError(error) : String(error);
      return JSON.stringify(
        {
          status: "error",
          message: `Failed to get exchange rate: ${errMsg}`,
          from_token: args.from_token,
          to_token: args.to_token,
        },
        null,
        2
      );
    }
  }
  
  return JSON.stringify(
    {
      status: "error",
      message: "Could not get exchange rate - minimum trade amount too high",
      from_token: args.from_token,
      to_token: args.to_token,
      suggestion: "Try using get_clob_swap_quote with a larger amount",
    },
    null,
    2
  );
}

// ============================================================================
// Order Management Handlers
// ============================================================================

async function handlePlaceLimitOrder(args: {
  from_token: string;
  to_token: string;
  amount: string;
  price: string;
  owner_address: string;
}): Promise<string> {
  return JSON.stringify(
    {
      status: "signature_required",
      message: "Limit orders require EIP-712 signature from wallet",
      order_params: {
        from_token: args.from_token,
        to_token: args.to_token,
        amount: args.amount,
        price: args.price,
        owner: args.owner_address,
      },
      instructions: [
        "1. Connect wallet to Sera app",
        "2. Navigate to Set Rate page",
        "3. Enter the order parameters",
        "4. Sign the EIP-712 message when prompted",
      ],
    },
    null,
    2
  );
}

async function handleGetOpenOrders(args: { wallet_address?: string }): Promise<string> {
  const ownerAddress = walletAddress || args.wallet_address;
  if (!ownerAddress) {
    return JSON.stringify(
      { status: "error", message: "No wallet address available. Set WALLET_PRIVATE_KEY." },
      null,
      2
    );
  }

  try {
    const response = await clobRequest<{
      orders: Array<{
        order_id: string;
        side: string;
        amount: string;
        price: string;
        filled_amount?: string;
        status: string;
        created_at: string;
      }>;
    }>("/orders", {
      params: { owner_address: ownerAddress.toLowerCase(), status: "open" },
      requiresAuth: true,
    });

    return JSON.stringify(
      {
        wallet: ownerAddress,
        open_orders: response.orders || [],
        count: response.orders?.length || 0,
      },
      null,
      2
    );
  } catch {
    return JSON.stringify(
      {
        wallet: ownerAddress,
        open_orders: [],
        count: 0,
        note: "Could not fetch orders - this endpoint may require authentication",
      },
      null,
      2
    );
  }
}

async function handleCancelOrder(args: {
  order_id: string;
  owner_address: string;
}): Promise<string> {
  return JSON.stringify(
    {
      status: "signature_required",
      message: "Order cancellation requires wallet signature",
      order_id: args.order_id,
      instructions: [
        "1. Connect wallet to Sera app",
        "2. Go to your orders",
        "3. Click cancel on the order",
        "4. Sign the cancellation request",
      ],
    },
    null,
    2
  );
}

// ============================================================================
// Deposit & Withdraw Handlers
// ============================================================================

async function handleGetExchangeBalance(args: { wallet_address?: string }): Promise<string> {
  const ownerAddress = walletAddress || args.wallet_address;
  if (!ownerAddress) {
    return JSON.stringify(
      { status: "error", message: "No wallet address available. Set WALLET_PRIVATE_KEY." },
      null,
      2
    );
  }

  const result = await safeClobRequest<{ balances: ClobBalanceItem[] }>("/balances", {
    params: { owner_address: ownerAddress.toLowerCase() },
    requiresAuth: true,
  });

  if (!result.success) {
    return JSON.stringify({ status: "error", message: result.error }, null, 2);
  }

  const items = result.data.balances || [];
  const exchangeBalances = items
    .filter((b) => {
      try {
        return BigInt(b.vault_available || "0") > 0n;
      } catch {
        return false;
      }
    })
    .map((b) => ({
      symbol: b.symbol,
      token_address: b.token,
      available: b.vault_available,
      total: b.vault_total,
    }));

  return JSON.stringify(
    {
      status: "success",
      wallet: ownerAddress,
      exchange_balances: exchangeBalances,
      count: exchangeBalances.length,
    },
    null,
    2
  );
}

async function handlePrepareDeposit(args: {
  token_address: string;
  amount: string;
  owner_address: string;
}): Promise<string> {
  try {
    // Convert human-readable amount to raw units
    const decimals = await getTokenDecimals(args.token_address);
    let rawAmount: string;
    try {
      rawAmount = toRawAmount(args.amount, decimals);
    } catch (e) {
      return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
    }

    const result = await clobRequest<{ to: string; data: string; value?: string }>("/deposit", {
      method: "POST",
      body: {
        token: args.token_address.toLowerCase(),
        amount: rawAmount,
        owner_address: args.owner_address.toLowerCase(),
      },
      requiresAuth: true,
    });

    return JSON.stringify(
      {
        status: "ready",
        message: "Deposit transaction ready to sign",
        deposit_tx: {
          to: result.to,
          data: result.data,
          value: result.value || "0",
        },
        token: args.token_address,
        amount: args.amount,
      },
      null,
      2
    );
  } catch (error) {
    const errMsg = error instanceof ClobApiError ? formatApiError(error) : String(error);
    return JSON.stringify({ status: "error", message: `Failed to prepare deposit: ${errMsg}` }, null, 2);
  }
}

async function handlePrepareWithdraw(args: {
  token_address: string;
  amount: string;
  owner_address: string;
}): Promise<string> {
  try {
    // Convert human-readable amount to raw units
    const decimals = await getTokenDecimals(args.token_address);
    let rawAmount: string;
    try {
      rawAmount = toRawAmount(args.amount, decimals);
    } catch (e) {
      return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
    }

    const result = await clobRequest<{ to: string; data: string; value?: string }>("/withdraw", {
      method: "POST",
      body: {
        token: args.token_address.toLowerCase(),
        amount: rawAmount,
        owner_address: args.owner_address.toLowerCase(),
      },
      requiresAuth: true,
    });

    return JSON.stringify(
      {
        status: "ready",
        message: "Withdrawal transaction ready to sign",
        withdraw_tx: {
          to: result.to,
          data: result.data,
          value: result.value || "0",
        },
        token: args.token_address,
        amount: args.amount,
      },
      null,
      2
    );
  } catch (error) {
    const errMsg = error instanceof ClobApiError ? formatApiError(error) : String(error);
    return JSON.stringify({ status: "error", message: `Failed to prepare withdrawal: ${errMsg}` }, null, 2);
  }
}

// ============================================================================
// Wallet Execution Handlers (requires WALLET_PRIVATE_KEY)
// ============================================================================

async function handleGetWalletInfo(): Promise<string> {
  try {
    const info = await getWalletInfo();
    return JSON.stringify(
      {
        status: "connected",
        address: info.address,
        balance_eth: info.balance,
        chain: info.chain,
      },
      null,
      2
    );
  } catch (error) {
    return JSON.stringify(
      {
        status: "not_configured",
        message: "Wallet not configured. Set WALLET_PRIVATE_KEY environment variable.",
      },
      null,
      2
    );
  }
}

// EIP-712 Intent types for swap execution signing
const INTENT_TYPES = {
  Intent: [
    { name: "taker", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
    { name: "deadline", type: "uint48" },
  ],
} as const;

// Safe BigInt conversion (matches webapp's safeBigInt)
function safeBigInt(value: string | number | undefined | null, field: string): bigint {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Swap quote is missing required field "${field}". Try again.`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Swap quote field "${field}" has an unparseable value (${String(value)}).`);
  }
}

// Check ERC20 allowance and approve if needed (for non-permit tokens)
// Returns true if an approval transaction was sent, false if allowance was sufficient
async function checkAndApproveToken(
  tokenAddress: string,
  spender: string,
  requiredAmount: bigint,
): Promise<{ approved: boolean; txHash?: string }> {
  if (!walletAddress || !publicClient) {
    throw new Error("Wallet not configured");
  }

  const token = tokenAddress.toLowerCase() as `0x${string}`;
  const spenderAddr = spender.toLowerCase() as `0x${string}`;
  const owner = walletAddress.toLowerCase() as `0x${string}`;

  // Read current allowance from chain
  let currentAllowance: bigint = 0n;
  try {
    const result = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spenderAddr],
    });
    currentAllowance = typeof result === "bigint" ? result : BigInt(String(result));
  } catch {
    // If we can't read allowance, assume 0 and proceed to approve
    currentAllowance = 0n;
  }

  if (currentAllowance >= requiredAmount) {
    return { approved: false };
  }

  // Send approve transaction with maxUint256 (infinite approval)
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spenderAddr, maxUint256],
  });

  const { hash, receipt } = await sendTransaction({
    to: token,
    data: approveData,
    value: "0",
  });

  if (receipt.status !== "success") {
    throw new Error(`Token approval transaction failed. tx_hash: ${hash}`);
  }

  return { approved: true, txHash: hash };
}

async function handleExecuteSwap(args: {
  from_token: string;
  to_token: string;
  amount: string;
}): Promise<string> {
  if (!walletAddress) {
    return JSON.stringify(
      { status: "error", message: "Wallet not configured. Set WALLET_PRIVATE_KEY." },
      null,
      2
    );
  }

  try {
    // Convert human-readable amount to raw units
    const fromDecimals = await getTokenDecimals(args.from_token);
    let rawAmount: string;
    try {
      rawAmount = toRawAmount(args.amount, fromDecimals);
    } catch (e) {
      return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
    }

    // Get swap quote
    let quote = await clobRequest<ClobSwapQuote>("/swap/quote", {
      method: "POST",
      body: {
        from_token: args.from_token.toLowerCase(),
        to_token: args.to_token.toLowerCase(),
        from_amount: rawAmount,
        owner_address: walletAddress.toLowerCase(),
        recipient: walletAddress.toLowerCase(),
        expiration: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    if (quote.no_liquidity) {
      return JSON.stringify({ status: "error", message: "No liquidity available for this pair" }, null, 2);
    }

    let route = quote.route_params;

    // Check if token approval is needed (non-permit tokens like USDT)
    let approvalTxHash: string | undefined;
    const permit = quote.permit;
    if (permit?.permit_required && !permit.permit_supported) {
      const spender = permit.spender || SERA_EIP712_DOMAIN.verifyingContract;
      const requiredAmount = safeBigInt(
        permit.value_raw || permit.value || route.maxInputAmount || rawAmount,
        "permit.value_raw"
      );

      const approvalResult = await checkAndApproveToken(
        args.from_token,
        spender,
        requiredAmount,
      );

      if (approvalResult.approved) {
        approvalTxHash = approvalResult.txHash;
        // Quote is likely expired after waiting for approval tx — refresh it
        const refreshedQuote = await clobRequest<ClobSwapQuote>("/swap/quote", {
          method: "POST",
          body: {
            from_token: args.from_token.toLowerCase(),
            to_token: args.to_token.toLowerCase(),
            from_amount: rawAmount,
            owner_address: walletAddress.toLowerCase(),
            recipient: walletAddress.toLowerCase(),
            expiration: Math.floor(Date.now() / 1000) + 3600,
          },
        });
        if (refreshedQuote.no_liquidity) {
          return JSON.stringify({ status: "error", message: "No liquidity available after token approval" }, null, 2);
        }
        // Use the refreshed quote for signing
        quote = refreshedQuote;
        route = refreshedQuote.route_params;
      }
    }

    // Sign the swap intent using EIP-712 typed data
    const signature = await signTypedData({
      privateKey: WALLET_PRIVATE_KEY as `0x${string}`,
      domain: SERA_EIP712_DOMAIN,
      types: INTENT_TYPES,
      primaryType: "Intent",
      message: {
        taker: walletAddress.toLowerCase() as `0x${string}`,
        inputToken: (route.inputToken as string).toLowerCase() as `0x${string}`,
        outputToken: (route.outputToken as string).toLowerCase() as `0x${string}`,
        maxInputAmount: safeBigInt(route.maxInputAmount, "route_params.maxInputAmount"),
        minOutputAmount: safeBigInt(route.minOutputAmount, "route_params.minOutputAmount"),
        recipient: (route.recipient as string).toLowerCase() as `0x${string}`,
        initialDepositAmount: safeBigInt(route.initialDepositAmount ?? "0", "route_params.initialDepositAmount"),
        uuid: safeBigInt(route.uuid, "route_params.uuid"),
        deadline: Number(route.deadline),
      },
    });

    // Submit swap with EIP-712 signature
    const swapResult = await clobRequest<{ 
      success?: boolean;
      trade_id?: string; 
      status?: string;
      tx_hash?: string; 
      error?: string;
    }>("/swap", {
      method: "POST",
      body: {
        uuid: quote.uuid,
        signature,
      },
      requiresAuth: true,
    });

    if (swapResult.error) {
      return JSON.stringify({ status: "error", message: swapResult.error }, null, 2);
    }

    // Get output token decimals for human-readable display
    const toDecimals = await getTokenDecimals(args.to_token);
    const outputRaw = BigInt(route.minOutputAmount || "0");
    const outputHuman = fromRawAmount(outputRaw.toString(), toDecimals);

    return JSON.stringify(
      {
        status: "success",
        message: "Swap executed successfully",
        trade_id: swapResult.trade_id,
        tx_hash: swapResult.tx_hash,
        approval_tx_hash: approvalTxHash,
        from_token: args.from_token,
        to_token: args.to_token,
        input_amount_raw: rawAmount,
        output_amount_raw: route.minOutputAmount,
        output_amount_human: outputHuman.toFixed(6),
      },
      null,
      2
    );
  } catch (error) {
    if (isNoLiquidityError(error)) {
      return JSON.stringify({ status: "no_liquidity", message: "No liquidity available for this pair" }, null, 2);
    }
    const errMsg = error instanceof ClobApiError ? formatApiError(error) : String(error);
    return JSON.stringify({ status: "error", message: `Swap failed: ${errMsg}` }, null, 2);
  }
}

async function handleExecuteDeposit(args: {
  token_address: string;
  amount: string;
}): Promise<string> {
  if (!walletAddress) {
    return JSON.stringify(
      { status: "error", message: "Wallet not configured. Set WALLET_PRIVATE_KEY." },
      null,
      2
    );
  }

  try {
    // Convert human-readable amount to raw units
    const decimals = await getTokenDecimals(args.token_address);
    let rawAmount: string;
    try {
      rawAmount = toRawAmount(args.amount, decimals);
    } catch (e) {
      return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
    }

    // Get deposit transaction
    const depositTx = await clobRequest<{ to: string; data: string; value?: string }>("/deposit", {
      method: "POST",
      body: {
        token: args.token_address.toLowerCase(),
        amount: rawAmount,
        owner_address: walletAddress.toLowerCase(),
      },
      requiresAuth: true,
    });

    // Send the transaction
    const { hash, receipt } = await sendTransaction(depositTx);

    return JSON.stringify(
      {
        status: receipt.status === "success" ? "success" : "failed",
        message: receipt.status === "success" ? "Deposit executed successfully" : "Deposit transaction failed",
        tx_hash: hash,
        block_number: receipt.blockNumber.toString(),
        token: args.token_address,
        amount: args.amount,
        amount_raw: rawAmount,
      },
      null,
      2
    );
  } catch (error) {
    const errMsg = error instanceof ClobApiError ? formatApiError(error) : String(error);
    return JSON.stringify({ status: "error", message: `Deposit failed: ${errMsg}` }, null, 2);
  }
}

async function handleExecuteWithdraw(args: {
  token_address: string;
  amount: string;
}): Promise<string> {
  if (!walletAddress) {
    return JSON.stringify(
      { status: "error", message: "Wallet not configured. Set WALLET_PRIVATE_KEY." },
      null,
      2
    );
  }

  try {
    // Convert human-readable amount to raw units
    const decimals = await getTokenDecimals(args.token_address);
    let rawAmount: string;
    try {
      rawAmount = toRawAmount(args.amount, decimals);
    } catch (e) {
      return JSON.stringify({ status: "error", message: (e as Error).message }, null, 2);
    }

    // Get withdraw transaction
    const withdrawTx = await clobRequest<{ to: string; data: string; value?: string }>("/withdraw", {
      method: "POST",
      body: {
        token: args.token_address.toLowerCase(),
        amount: rawAmount,
        owner_address: walletAddress.toLowerCase(),
      },
      requiresAuth: true,
    });

    // Send the transaction
    const { hash, receipt } = await sendTransaction(withdrawTx);

    return JSON.stringify(
      {
        status: receipt.status === "success" ? "success" : "failed",
        message: receipt.status === "success" ? "Withdrawal executed successfully" : "Withdrawal transaction failed",
        tx_hash: hash,
        block_number: receipt.blockNumber.toString(),
        token: args.token_address,
        amount: args.amount,
        amount_raw: rawAmount,
      },
      null,
      2
    );
  } catch (error) {
    const errMsg = error instanceof ClobApiError ? formatApiError(error) : String(error);
    return JSON.stringify({ status: "error", message: `Withdrawal failed: ${errMsg}` }, null, 2);
  }
}

// Main server setup
async function main() {
  console.error(`Sera MCP Server starting...`);
  console.error(`  EXTERNAL_API_URL: ${EXTERNAL_API_URL}`);
  console.error(`  Chain: ${chain.name}`);
  if (walletAddress) {
    console.error(`  Wallet: ${walletAddress}`);
  } else {
    console.error(`  Wallet: Not configured (set WALLET_PRIVATE_KEY for transaction execution)`);
  }

  const server = new Server(
    {
      name: "sera-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        // Market Data Tools
        case "get_market":
          result = await handleGetMarket(args as { page?: number; per_page?: number });
          break;
        case "get_coin_metadata":
          result = await handleGetCoinMetadata(args as { ticker: string });
          break;
        case "get_coin_history":
          result = await handleGetCoinHistory(args as { ticker: string; days?: number });
          break;
        case "search_coins":
          result = await handleSearchCoins(args as { query: string; limit?: number });
          break;

        // Wallet & Balance Tools
        case "get_wallet_balances":
          result = await handleGetWalletBalances(
            args as { wallet_address?: string; page?: number; page_size?: number }
          );
          break;

        // Trading Tools
        case "get_trading_pairs":
          result = await handleGetTradingPairs(args as { token_address: string });
          break;
        case "get_swap_quote":
          result = await handleGetSwapQuote(
            args as { market_id: string; direction: "ASK" | "BID"; amount_in: string }
          );
          break;
        case "prepare_swap":
          result = await handlePrepareSwap(
            args as {
              market_address: string;
              from_token: string;
              to_token: string;
              direction: string;
              amount_in: string;
              user_address: string;
            }
          );
          break;
        case "get_clob_swap_quote":
          result = await handleGetClobSwapQuote(
            args as {
              from_token: string;
              to_token: string;
              from_amount: string;
              owner_address?: string;
            }
          );
          break;
        case "get_exchange_rate":
          result = await handleGetExchangeRate(
            args as {
              from_token: string;
              to_token: string;
              from_decimals?: number;
              to_decimals?: number;
            }
          );
          break;

        // Order Management Tools
        case "place_limit_order":
          result = await handlePlaceLimitOrder(
            args as {
              from_token: string;
              to_token: string;
              amount: string;
              price: string;
              owner_address: string;
            }
          );
          break;
        case "get_open_orders":
          result = await handleGetOpenOrders(args as { wallet_address?: string });
          break;
        case "cancel_order":
          result = await handleCancelOrder(
            args as { order_id: string; owner_address: string }
          );
          break;

        // Deposit & Withdraw Tools
        case "get_exchange_balance":
          result = await handleGetExchangeBalance(args as { wallet_address?: string });
          break;
        case "prepare_deposit":
          result = await handlePrepareDeposit(
            args as { token_address: string; amount: string; owner_address: string }
          );
          break;
        case "prepare_withdraw":
          result = await handlePrepareWithdraw(
            args as { token_address: string; amount: string; owner_address: string }
          );
          break;

        // Wallet Execution Tools (requires WALLET_PRIVATE_KEY)
        case "get_wallet_info":
          result = await handleGetWalletInfo();
          break;
        case "execute_swap":
          result = await handleExecuteSwap(
            args as { from_token: string; to_token: string; amount: string }
          );
          break;
        case "execute_deposit":
          result = await handleExecuteDeposit(
            args as { token_address: string; amount: string }
          );
          break;
        case "execute_withdraw":
          result = await handleExecuteWithdraw(
            args as { token_address: string; amount: string }
          );
          break;

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sera MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
