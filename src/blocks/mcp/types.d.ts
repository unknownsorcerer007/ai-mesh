declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export class McpServer {
    constructor(opts: { name: string; version: string });
    tool(name: string, description: string, schema: unknown, handler: (args: any) => Promise<any>): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
    constructor();
  }
}

declare module '@modelcontextprotocol/sdk/server/sse.js' {
  export class SSEServerTransport {
    constructor(path: string, res: unknown);
  }
}

declare module '@modelcontextprotocol/sdk/server/streamableHttp.js' {
  export class StreamableHTTPServerTransport {
    constructor(opts: { sessionIdGenerator?: unknown });
    handleRequest(req: unknown, res: unknown): Promise<void>;
    onclose?: (() => void) | undefined;
    sessionId?: string;
  }
}
