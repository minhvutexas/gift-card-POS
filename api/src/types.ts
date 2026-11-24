export type ActorType = 'USER' | 'KIOSK' | 'GATEWAY' | 'SYSTEM' | 'IMPORT';

export interface AuthUser {
  id: number;
  name: string;
  username: string;
  role: string;
  perms: Set<string>;
}

export interface BusinessInfo {
  id: number;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface TerminalInfo {
  id: number;
  code: string;
  name: string;
  kind: 'POS' | 'KIOSK';
}

/** Who is doing something, where from. Passed to every fn_* call. */
export interface Actor {
  actorType: ActorType;
  actorId: number | null;
  terminalId: number | null;
  ip: string | null;
  ua: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      business?: BusinessInfo;
      terminal?: TerminalInfo;
      idempotencyKey?: string;
    }
  }
}
