import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import {
  CREATE_DIAGNOSTIC_READ_PATH,
  CREATE_DIAGNOSTIC_RETENTION_SECONDS,
  validCreateDiagnosticEvent,
  type CreateDiagnosticEvent,
  type CreateDiagnosticReceipt,
} from "../../model-chat/lib/create-diagnostics";

/**
 * The single administrator this deployment authorizes, read from the
 * `ADMIN_EMAIL` secret. Deliberately not hard-coded: a checked-in address is a
 * personal detail in a public repo, and it would also make the Worker
 * un-authorizable for anyone deploying their own copy.
 */
export function adminEmail(env: AuthEnv): string {
  const email = env.ADMIN_EMAIL?.trim();
  if (!email) throw new Error("ADMIN_EMAIL is not configured as a Worker secret.");
  return email;
}
const SESSION = "nimble_playground_session";
const SPEND = "nimble_playground_spend";
const BOOTSTRAP = "nimble_playground_bootstrap";
const CSRF = "nimble_playground_csrf";
const SESSION_SECONDS = 12 * 60 * 60;
const BOOTSTRAP_SECONDS = 10 * 60;
const OTP_SECONDS = 10 * 60;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 6;
const AUTH_EMAIL_ADDRESS = "login@auth.kadosh.dev";
const AGENT_CHALLENGE_SECONDS = 60;
const AGENT_SESSION_SECONDS = 15 * 60;
const AGENT_ACTIVATION_CAPACITY = 8;
const AGENT_NONCE_CAPACITY = 64;
const SESSION_REVOCATION_CAPACITY = 128;
const AGENT_RATE_WINDOW_SECONDS = 60;
const AGENT_RATE_LIMIT = 20;
const OTP_RATE_WINDOW_SECONDS = 60 * 60;
const OTP_RATE_LIMIT = 5;
const RATE_BUCKET_CAPACITY = 128;
const OTP_CHALLENGE_CAPACITY = 128;
const SPEND_GRANT_SECONDS = 5 * 60;
const CREATE_DIAGNOSTIC_STORAGE_KEY = "create-diagnostic-current";
const CREATE_DIAGNOSTIC_CAPACITY = 16;
const SPEND_INTEGRATION = "vercel-ai-sdk-agent-v2";
const AUTH_CHALLENGE_SECONDS = 5 * 60;
const AUTH_CHALLENGE_CAPACITY = 32;
const DIRECT_RUN_OWNER_CAPACITY = 16;
const SPEND_EPOCH_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,47}:([1-9][0-9]{0,9})$/;
const CHAT_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function spendEpochGeneration(epoch: string): number | null {
  const match = epoch.match(SPEND_EPOCH_PATTERN);
  if (!match) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? generation : null;
}

export interface AuthEnv {
  ADMIN_AUTH: DurableObjectNamespace<AdminAuthState>;
  /** The only identity this deployment authorizes. Required. */
  ADMIN_EMAIL?: string;
  ADMIN_PASSKEY?: string;
  ADMIN_SESSION_SECRET?: string;
  AUTH_RP_ID?: string;
  AUTH_EMPLOYEE_ENABLED?: string;
  SPEND_GRANT_EPOCH?: string;
  AUTH_EMAIL?: { send(message: EmailMessage): Promise<unknown> };
  AGENT_AUTH_PUBLIC_KEY?: string;
  AGENT_AUTH_KEY_ID?: string;
  AGENT_AUTH_WORKSPACE_ID?: string;
}

interface OtpChallenge {
  emailDigest: string;
  codeDigest: string;
  magicDigest: string;
  expiresAt: number;
  attemptsRemaining: number;
  lastSentAt: number;
}

interface StoredCredential {
  id: string;
  publicKey: number[];
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}

interface AuthenticationChallenge {
  ceremonyDigest: string;
  challenge: string;
  expiresAt: number;
}

interface AgentActivation {
  tokenDigest: string;
  keyId: string;
  next: string;
  expiresAt: number;
}

interface AuthSession {
  sid: string;
  authzVersion: number;
  authenticatedAt: number;
  email: string;
  role: "admin" | "employee" | "agent";
  aud: string;
  expiresAt: number;
}

export interface SpendGrant {
  grantId: string;
  sid: string;
  authzVersion: number;
  aud: string;
  epoch: string;
  integration: typeof SPEND_INTEGRATION;
  effortCeiling: "low";
  createLimit: 1;
  expiresAt: number;
}

interface StoredSpendGrant {
  epoch: string;
  generation: number;
  sidDigest: string;
  grantDigest: string;
  expiresAt: number;
  consumed: boolean;
}

type StoredCreateDiagnosticReceipt = CreateDiagnosticReceipt & {
  sidDigest: string;
  sequence: number;
  cleared: false;
};

type StoredCreateDiagnosticTombstone = {
  sidDigest: string;
  correlationId: string;
  sequence: number;
  cleared: true;
  observedAt: number;
  expiresAt: number;
};

type StoredCreateDiagnosticState =
  | StoredCreateDiagnosticReceipt
  | StoredCreateDiagnosticTombstone;

type StoredCreateDiagnosticSlot = {
  requestId: string;
  sidDigest: string;
  expiresAt: number;
  state?: StoredCreateDiagnosticState;
};

type CreateDiagnosticLookup =
  | { kind: "receipt"; receipt: CreateDiagnosticReceipt }
  | { kind: "none" }
  | { kind: "denied" };

function activeCreateDiagnosticSlots(
  value: unknown,
  now: number,
): StoredCreateDiagnosticSlot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (slot): slot is StoredCreateDiagnosticSlot =>
      Boolean(slot) &&
      typeof slot === "object" &&
      CHAT_REQUEST_ID_PATTERN.test(String(slot.requestId || "")) &&
      /^[A-Za-z0-9_-]{43}$/.test(String(slot.sidDigest || "")) &&
      Number.isInteger(slot.expiresAt) &&
      Number(slot.expiresAt) > now,
  );
}

function nextCreateDiagnosticExpiry(
  slots: StoredCreateDiagnosticSlot[],
): number {
  return Math.min(...slots.map((slot) => slot.expiresAt));
}

export class AdminAuthState extends DurableObject<AuthEnv> {
  async allowOtpRequest(emailDigest: string, sourceDigest: string, now: number): Promise<boolean> {
    const key = "otp-rate-buckets";
    const subjects = [
      { kind: "email", digest: emailDigest },
      { kind: "source", digest: sourceDigest },
    ];
    return this.ctx.storage.transaction(async (transaction) => {
      const stored =
        (await transaction.get<{
          kind: string;
          digest: string;
          count: number;
          resetAt: number;
        }[]>(key)) || [];
      const active = stored.filter((bucket) => bucket.resetAt > now);
      const matched = subjects.map((subject) =>
        active.find((bucket) =>
          bucket.kind === subject.kind && same(bucket.digest, subject.digest)
        ),
      );
      if (matched.some((bucket) => bucket && bucket.count >= OTP_RATE_LIMIT)) return false;
      const missing = matched.filter((bucket) => !bucket).length;
      if (active.length + missing > RATE_BUCKET_CAPACITY) return false;
      subjects.forEach((subject, index) => {
        const bucket = matched[index];
        if (bucket) bucket.count += 1;
        else active.push({
          ...subject,
          count: 1,
          resetAt: now + OTP_RATE_WINDOW_SECONDS,
        });
      });
      await transaction.put(key, active);
      return true;
    });
  }
  async issueSpendGrant(
    epoch: string,
    sid: string,
    grantId: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    const generation = spendEpochGeneration(epoch);
    if (
      generation === null ||
      expiresAt <= now ||
      !/^[A-Za-z0-9_-]{43}$/.test(sid) ||
      !/^[A-Za-z0-9_-]{43}$/.test(grantId)
    ) return false;
    const record = {
      epoch,
      generation,
      sidDigest: await digest(sid),
      grantDigest: await digest(grantId),
      expiresAt,
      consumed: false,
    } satisfies StoredSpendGrant;
    const key = "spend-grant-current";
    const generationKey = "spend-grant-generation";
    return this.ctx.storage.transaction(async (transaction) => {
      const highestGeneration = (await transaction.get<number>(generationKey)) || 0;
      if (generation <= highestGeneration) return false;
      await transaction.put(key, record);
      await transaction.put(generationKey, generation);
      return true;
    });
  }
  async consumeSpendGrant(
    epoch: string,
    sid: string,
    grantId: string,
    now: number,
    requestId?: string,
    sessionExpiresAt?: number,
  ): Promise<boolean> {
    const bindsChatRequest =
      requestId !== undefined || sessionExpiresAt !== undefined;
    if (
      spendEpochGeneration(epoch) === null ||
      !/^[A-Za-z0-9_-]{43}$/.test(sid) ||
      !/^[A-Za-z0-9_-]{43}$/.test(grantId) ||
      (bindsChatRequest &&
        (!requestId ||
          !CHAT_REQUEST_ID_PATTERN.test(requestId) ||
          !Number.isInteger(sessionExpiresAt) ||
          Number(sessionExpiresAt) <= now))
    ) return false;
    const sidDigest = await digest(sid);
    const grantDigest = await digest(grantId);
    const key = "spend-grant-current";
    const consumed = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<StoredSpendGrant>(key);
      if (
        !record ||
        record.epoch !== epoch ||
        record.consumed ||
        record.expiresAt <= now ||
        !same(record.sidDigest, sidDigest) ||
        !same(record.grantDigest, grantDigest)
      ) return false;
      if (bindsChatRequest) {
        const slots = activeCreateDiagnosticSlots(
          await transaction.get<unknown>(
            CREATE_DIAGNOSTIC_STORAGE_KEY,
          ),
          now,
        );
        if (
          slots.length >= CREATE_DIAGNOSTIC_CAPACITY ||
          slots.some(
            (slot) =>
              slot.requestId === requestId &&
              same(slot.sidDigest, sidDigest),
          )
        ) {
          return false;
        }
        slots.push({
          requestId: requestId!,
          sidDigest,
          expiresAt: Math.min(
            Number(sessionExpiresAt),
            now + CREATE_DIAGNOSTIC_RETENTION_SECONDS,
          ),
        });
        await transaction.put(
          CREATE_DIAGNOSTIC_STORAGE_KEY,
          slots,
        );
        await transaction.setAlarm(
          nextCreateDiagnosticExpiry(slots) * 1_000,
        );
      }
      record.consumed = true;
      await transaction.put(key, record);
      return true;
    });
    return consumed;
  }
  async recordCreateDiagnostic(
    sidDigest: string,
    requestId: string,
    sequence: number,
    event: CreateDiagnosticEvent,
    now: number,
  ): Promise<boolean> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(sidDigest) ||
      !CHAT_REQUEST_ID_PATTERN.test(requestId) ||
      !Number.isInteger(sequence) ||
      sequence < 1 ||
      sequence > 64 ||
      !Number.isInteger(now) ||
      now <= 0 ||
      !validCreateDiagnosticEvent(event) ||
      event.correlationId !== requestId
    ) return false;
    const phaseRank: Record<CreateDiagnosticEvent["phase"], number> = {
      pre_network_rejection: 0,
      outbound_post_attempt: 1,
      provider_response: 2,
      transport_ambiguity: 2,
    };
    return this.ctx.storage.transaction(
      async (transaction): Promise<boolean> => {
        const storedSlots = await transaction.get<unknown>(
          CREATE_DIAGNOSTIC_STORAGE_KEY,
        );
        const slots = activeCreateDiagnosticSlots(storedSlots, now);
        const pruned =
          !Array.isArray(storedSlots) ||
          storedSlots.length !== slots.length;
        const persist = async () => {
          if (slots.length === 0) {
            await transaction.delete(CREATE_DIAGNOSTIC_STORAGE_KEY);
            await transaction.deleteAlarm();
            return;
          }
          await transaction.put(CREATE_DIAGNOSTIC_STORAGE_KEY, slots);
          await transaction.setAlarm(
            nextCreateDiagnosticExpiry(slots) * 1_000,
          );
        };
        const slot = slots.find(
          (candidate) =>
            candidate.requestId === requestId &&
            same(candidate.sidDigest, sidDigest),
        );
        if (!slot) {
          if (pruned) await persist();
          return false;
        }
        const stored = slot.state;
        if (
          stored &&
          (stored.cleared ||
            sequence <= stored.sequence ||
            phaseRank[stored.phase] > phaseRank[event.phase] ||
            (phaseRank[stored.phase] === phaseRank[event.phase] &&
              stored.phase !== event.phase))
        ) {
          if (pruned) await persist();
          return false;
        }
        slot.state = {
          ...event,
          sidDigest,
          sequence,
          cleared: false,
          observedAt: now,
          expiresAt: slot.expiresAt,
        } satisfies StoredCreateDiagnosticReceipt;
        await persist();
        return true;
      },
    );
  }
  async clearCreateDiagnostic(
    sidDigest: string,
    requestId: string,
    sequence: number,
    now: number,
  ): Promise<boolean> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(sidDigest) ||
      !CHAT_REQUEST_ID_PATTERN.test(requestId) ||
      !Number.isInteger(sequence) ||
      sequence < 1 ||
      sequence > 64 ||
      !Number.isInteger(now) ||
      now <= 0
    ) return false;
    const cleared = await this.ctx.storage.transaction(async (transaction) => {
      const storedSlots = await transaction.get<unknown>(
        CREATE_DIAGNOSTIC_STORAGE_KEY,
      );
      const slots = activeCreateDiagnosticSlots(storedSlots, now);
      const pruned =
        !Array.isArray(storedSlots) ||
        storedSlots.length !== slots.length;
      const persist = async () => {
        if (slots.length === 0) {
          await transaction.delete(CREATE_DIAGNOSTIC_STORAGE_KEY);
          await transaction.deleteAlarm();
          return;
        }
        await transaction.put(CREATE_DIAGNOSTIC_STORAGE_KEY, slots);
        await transaction.setAlarm(
          nextCreateDiagnosticExpiry(slots) * 1_000,
        );
      };
      const slot = slots.find(
        (candidate) =>
          candidate.requestId === requestId &&
          same(candidate.sidDigest, sidDigest),
      );
      if (!slot) {
        if (pruned) await persist();
        return false;
      }
      const stored = slot.state;
      if (
        stored &&
        (stored.cleared ||
          sequence <= stored.sequence)
      ) {
        if (pruned) await persist();
        return false;
      }
      slot.state = {
        sidDigest,
        correlationId: requestId,
        sequence,
        cleared: true,
        observedAt: now,
        expiresAt: slot.expiresAt,
      } satisfies StoredCreateDiagnosticTombstone;
      await persist();
      return true;
    });
    return cleared;
  }
  async readCreateDiagnostic(
    sid: string,
    requestId: string,
    now: number,
  ): Promise<CreateDiagnosticLookup> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(sid) ||
      !CHAT_REQUEST_ID_PATTERN.test(requestId) ||
      !Number.isInteger(now) ||
      now <= 0
    ) return { kind: "denied" };
    const sidDigest = await digest(sid);
    return this.ctx.storage.transaction(async (transaction) => {
      const storedSlots = await transaction.get<unknown>(
        CREATE_DIAGNOSTIC_STORAGE_KEY,
      );
      const slots = activeCreateDiagnosticSlots(storedSlots, now);
      if (
        !Array.isArray(storedSlots) ||
        storedSlots.length !== slots.length
      ) {
        if (slots.length === 0) {
          await transaction.delete(CREATE_DIAGNOSTIC_STORAGE_KEY);
          await transaction.deleteAlarm();
        } else {
          await transaction.put(CREATE_DIAGNOSTIC_STORAGE_KEY, slots);
          await transaction.setAlarm(
            nextCreateDiagnosticExpiry(slots) * 1_000,
          );
        }
      }
      const slot = slots.find(
        (candidate) =>
          candidate.requestId === requestId &&
          same(candidate.sidDigest, sidDigest),
      );
      if (!slot) {
        return { kind: "denied" };
      }
      const stored = slot.state;
      if (!stored) return { kind: "none" };
      if (
        stored.correlationId !== requestId ||
        !same(stored.sidDigest, sidDigest)
      ) {
        return { kind: "denied" };
      }
      if (stored.cleared) return { kind: "none" };
      const {
        sidDigest: _sidDigest,
        sequence: _sequence,
        cleared: _cleared,
        ...receipt
      } = stored;
      return { kind: "receipt", receipt };
    });
  }
  async alarm(): Promise<void> {
    const slots = activeCreateDiagnosticSlots(
      await this.ctx.storage.get<unknown>(
        CREATE_DIAGNOSTIC_STORAGE_KEY,
      ),
      Math.floor(Date.now() / 1_000),
    );
    if (slots.length === 0) {
      await this.ctx.storage.delete(CREATE_DIAGNOSTIC_STORAGE_KEY);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.put(
      CREATE_DIAGNOSTIC_STORAGE_KEY,
      slots,
    );
    await this.ctx.storage.setAlarm(
      nextCreateDiagnosticExpiry(slots) * 1_000,
    );
  }
  async consumeSpendGrantAndReserveDirectRun(
    epoch: string,
    sid: string,
    grantId: string,
    expiresAt: number,
    now: number,
  ): Promise<boolean> {
    if (
      spendEpochGeneration(epoch) === null ||
      expiresAt <= now ||
      !/^[A-Za-z0-9_-]{43}$/.test(sid) ||
      !/^[A-Za-z0-9_-]{43}$/.test(grantId)
    ) return false;
    const sidDigest = await digest(sid);
    const grantDigest = await digest(grantId);
    const spendKey = "spend-grant-current";
    const ownersKey = "direct-run-owners";
    return this.ctx.storage.transaction(async (transaction) => {
      const spend = await transaction.get<{
        epoch: string;
        sidDigest: string;
        grantDigest: string;
        expiresAt: number;
        consumed: boolean;
      }>(spendKey);
      if (
        !spend ||
        spend.epoch !== epoch ||
        spend.consumed ||
        spend.expiresAt <= now ||
        !same(spend.sidDigest, sidDigest) ||
        !same(spend.grantDigest, grantDigest)
      ) return false;
      const stored =
        (await transaction.get<{
          epoch: string;
          sidDigest: string;
          runId?: string;
          agentId?: string;
          expiresAt: number;
        }[]>(ownersKey)) || [];
      const active = stored.filter((record) => record.expiresAt > now);
      if (active.some((record) => record.epoch === epoch)) return false;
      if (active.length >= DIRECT_RUN_OWNER_CAPACITY) return false;
      active.push({ epoch, sidDigest, expiresAt });
      spend.consumed = true;
      await transaction.put(spendKey, spend);
      await transaction.put(ownersKey, active);
      return true;
    });
  }
  async bindDirectRunOwner(
    epoch: string,
    sid: string,
    runId: string,
    agentId: string,
    now: number,
  ): Promise<boolean> {
    if (
      spendEpochGeneration(epoch) === null ||
      !/^[A-Za-z0-9_-]{43}$/.test(sid) ||
      !/^task_run_[A-Za-z0-9_-]{1,160}$/.test(runId) ||
      !/^[A-Za-z0-9_-]{1,192}$/.test(agentId)
    ) return false;
    const sidDigest = await digest(sid);
    const key = "direct-run-owners";
    return this.ctx.storage.transaction(async (transaction) => {
      const active =
        (await transaction.get<{
          epoch: string;
          sidDigest: string;
          runId?: string;
          agentId?: string;
          expiresAt: number;
        }[]>(key)) || [];
      const record = active.find((candidate) =>
        candidate.expiresAt > now &&
        candidate.epoch === epoch &&
        same(candidate.sidDigest, sidDigest)
      );
      if (!record || record.runId || record.agentId) return false;
      record.runId = runId;
      record.agentId = agentId;
      await transaction.put(key, active.filter((candidate) => candidate.expiresAt > now));
      return true;
    });
  }
  async ownsDirectRun(
    sid: string,
    runId: string,
    agentId: string,
    now: number,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sid)) return false;
    const sidDigest = await digest(sid);
    const key = "direct-run-owners";
    return this.ctx.storage.transaction(async (transaction) => {
      const stored =
        (await transaction.get<{
          epoch: string;
          sidDigest: string;
          runId?: string;
          agentId?: string;
          expiresAt: number;
        }[]>(key)) || [];
      const active = stored.filter((record) => record.expiresAt > now);
      if (active.length !== stored.length) await transaction.put(key, active);
      return active.some((record) =>
        same(record.sidDigest, sidDigest) &&
        typeof record.runId === "string" &&
        typeof record.agentId === "string" &&
        same(record.runId, runId) &&
        same(record.agentId, agentId)
      );
    });
  }
  async allowAgentRequest(
    scope: string,
    sourceDigest: string,
    keyDigest: string,
    now: number,
  ): Promise<boolean> {
    const key = "agent-rate-buckets";
    const subjects = [
      { kind: "source", digest: sourceDigest },
      { kind: "key", digest: keyDigest },
    ];
    return this.ctx.storage.transaction(async (transaction) => {
      const stored =
        (await transaction.get<{
          scope: string;
          kind: string;
          digest: string;
          count: number;
          resetAt: number;
        }[]>(key)) || [];
      const active = stored.filter((bucket) => bucket.resetAt > now);
      const matched = subjects.map((subject) =>
        active.find((bucket) =>
          bucket.scope === scope &&
          bucket.kind === subject.kind &&
          same(bucket.digest, subject.digest)
        ),
      );
      if (matched.some((bucket) => bucket && bucket.count >= AGENT_RATE_LIMIT)) return false;
      const missing = matched.filter((bucket) => !bucket).length;
      if (active.length + missing > RATE_BUCKET_CAPACITY) return false;
      subjects.forEach((subject, index) => {
        const bucket = matched[index];
        if (bucket) bucket.count += 1;
        else active.push({
          scope,
          ...subject,
          count: 1,
          resetAt: now + AGENT_RATE_WINDOW_SECONDS,
        });
      });
      await transaction.put(key, active);
      return true;
    });
  }
  async authzVersion(): Promise<number> {
    return (await this.ctx.storage.get<number>("authz-version")) || 1;
  }
  async isAuthSessionValid(
    sid: string,
    authzVersion: number,
    now: number,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sid) || authzVersion !== await this.authzVersion()) {
      return false;
    }
    const key = "revoked-sessions";
    return this.ctx.storage.transaction(async (transaction) => {
      const existing =
        (await transaction.get<{ sid: string; expiresAt: number }[]>(key)) || [];
      const active = existing.filter((entry) => entry.expiresAt > now);
      if (active.length !== existing.length) await transaction.put(key, active);
      return !active.some((entry) => same(entry.sid, sid));
    });
  }
  async revokeAuthSession(sid: string, expiresAt: number, now: number): Promise<void> {
    const key = "revoked-sessions";
    await this.ctx.storage.transaction(async (transaction) => {
      const existing =
        (await transaction.get<{ sid: string; expiresAt: number }[]>(key)) || [];
      const active = existing.filter((entry) => entry.expiresAt > now);
      if (active.some((entry) => same(entry.sid, sid))) return;
      if (active.length >= SESSION_REVOCATION_CAPACITY) {
        const version = (await transaction.get<number>("authz-version")) || 1;
        await transaction.put("authz-version", version + 1);
        await transaction.delete(key);
        return;
      }
      active.push({ sid, expiresAt });
      await transaction.put(key, active);
    });
  }
  async consumeAgentNonce(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    const key = "used-agent-nonces";
    return this.ctx.storage.transaction(async (transaction) => {
      const existing =
        (await transaction.get<{ nonce: string; expiresAt: number }[]>(key)) || [];
      const active = existing.filter((entry) => entry.expiresAt > now);
      if (active.some((entry) => same(entry.nonce, nonce))) return false;
      if (active.length >= AGENT_NONCE_CAPACITY) {
        await transaction.put(key, active);
        return false;
      }
      active.push({ nonce, expiresAt });
      await transaction.put(key, active);
      return true;
    });
  }
  async beginAgentActivation(
    token: string,
    keyId: string,
    next: string,
    expiresAt: number,
    now = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const key = "agent-activations";
    const tokenDigest = await digest(token);
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = (await transaction.get<AgentActivation[]>(key)) || [];
      const active = existing.filter((entry) => entry.expiresAt > now);
      if (active.length >= AGENT_ACTIVATION_CAPACITY) {
        await transaction.put(key, active);
        return false;
      }
      active.push({ tokenDigest, keyId, next, expiresAt });
      await transaction.put(key, active);
      return true;
    });
  }
  async consumeAgentActivation(token: string, now: number): Promise<AgentActivation | null> {
    const key = "agent-activations";
    const tokenDigest = await digest(token);
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = (await transaction.get<AgentActivation[]>(key)) || [];
      const index = existing.findIndex((entry) =>
        entry.expiresAt > now && same(entry.tokenDigest, tokenDigest)
      );
      if (index < 0) {
        await transaction.put(key, existing.filter((entry) => entry.expiresAt > now));
        return null;
      }
      const [activation] = existing.splice(index, 1);
      await transaction.put(key, existing.filter((entry) => entry.expiresAt > now));
      return activation || null;
    });
  }
  private async credentials(): Promise<StoredCredential[]> {
    const current = await this.ctx.storage.get<StoredCredential[]>("credentials");
    if (current) return current;
    const legacy = await this.ctx.storage.get<StoredCredential>("credential");
    return legacy ? [legacy] : [];
  }
  async beginOtp(email: string, codeDigest: string, magicDigest: string, now: number) {
    const key = "otp-challenges";
    const emailDigest = await digest(email);
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = (await transaction.get<OtpChallenge[]>(key)) || [];
      const active = stored.filter((challenge) => challenge.expiresAt > now);
      const index = active.findIndex((challenge) =>
        same(challenge.emailDigest, emailDigest)
      );
      const existing = index >= 0 ? active[index] : undefined;
      if (existing && now - existing.lastSentAt < OTP_RESEND_SECONDS) {
        if (active.length !== stored.length) await transaction.put(key, active);
        return {
          accepted: false,
          retryAfter: OTP_RESEND_SECONDS - (now - existing.lastSentAt),
          capacity: false,
        };
      }
      if (!existing && active.length >= OTP_CHALLENGE_CAPACITY) {
        await transaction.put(key, active);
        return {
          accepted: false,
          retryAfter: OTP_RESEND_SECONDS,
          capacity: true,
        };
      }
      const challenge = {
        emailDigest,
        codeDigest,
        magicDigest,
        expiresAt: now + OTP_SECONDS,
        attemptsRemaining: OTP_MAX_ATTEMPTS,
        lastSentAt: now,
      } satisfies OtpChallenge;
      if (index >= 0) active[index] = challenge;
      else active.push(challenge);
      await transaction.put(key, active);
      return { accepted: true, retryAfter: 0, capacity: false };
    });
  }
  async verifyOtp(email: string, codeDigest: string, now: number) {
    const key = "otp-challenges";
    const emailDigest = await digest(email);
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = (await transaction.get<OtpChallenge[]>(key)) || [];
      const active = stored.filter((challenge) =>
        challenge.expiresAt > now && challenge.attemptsRemaining > 0
      );
      const index = active.findIndex((challenge) =>
        same(challenge.emailDigest, emailDigest)
      );
      if (index < 0) {
        if (active.length !== stored.length) await transaction.put(key, active);
        return false;
      }
      const challenge = active[index]!;
      if (!same(challenge.codeDigest, codeDigest)) {
        challenge.attemptsRemaining -= 1;
        if (challenge.attemptsRemaining <= 0) active.splice(index, 1);
        await transaction.put(key, active);
        return false;
      }
      active.splice(index, 1);
      await transaction.put(key, active);
      return true;
    });
  }
  async verifyMagicLink(email: string, magicDigest: string, now: number) {
    const key = "otp-challenges";
    const emailDigest = await digest(email);
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = (await transaction.get<OtpChallenge[]>(key)) || [];
      const active = stored.filter((challenge) => challenge.expiresAt > now);
      const index = active.findIndex((challenge) =>
        same(challenge.emailDigest, emailDigest)
      );
      if (index < 0) {
        if (active.length !== stored.length) await transaction.put(key, active);
        return false;
      }
      if (!same(active[index]!.magicDigest, magicDigest)) {
        if (active.length !== stored.length) await transaction.put(key, active);
        return false;
      }
      active.splice(index, 1);
      await transaction.put(key, active);
      return true;
    });
  }
  async clearOtp(email: string) {
    const key = "otp-challenges";
    const emailDigest = await digest(email);
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = (await transaction.get<OtpChallenge[]>(key)) || [];
      const remaining = stored.filter((challenge) =>
        !same(challenge.emailDigest, emailDigest)
      );
      if (remaining.length !== stored.length) await transaction.put(key, remaining);
    });
  }
  async hasPasskey(): Promise<boolean> {
    return (await this.credentials()).length > 0;
  }
  async registrationOptions(rpID: string, addBackup = false) {
    const credentials = await this.credentials();
    if (credentials.length && !addBackup) throw new Error("A passkey is already registered");
    const options = await generateRegistrationOptions({
      rpName: "Nimble Integration Playground",
      rpID,
      userName: adminEmail(this.env),
      userDisplayName: "Playground administrator",
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
    });
    await this.ctx.storage.put("registrationChallenge", options.challenge);
    return options;
  }
  async completeRegistration(response: RegistrationResponseJSON, rpID: string, origin: string, addBackup = false) {
    const credentials = await this.credentials();
    if (credentials.length && !addBackup) throw new Error("A passkey is already registered");
    const challenge = await this.ctx.storage.get<string>("registrationChallenge");
    if (!challenge) throw new Error("Registration challenge expired");
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) throw new Error("Registration failed");
    const credential = result.registrationInfo.credential;
    const stored = {
      id: credential.id,
      publicKey: Array.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    } satisfies StoredCredential;
    await this.ctx.storage.put("credentials", [...credentials, stored]);
    await this.ctx.storage.delete("credential");
    await this.ctx.storage.delete("registrationChallenge");
  }
  async authenticationOptions(
    rpID: string,
    ceremonyDigest: string,
    now: number,
  ) {
    const credentials = await this.credentials();
    if (!credentials.length) throw new Error("No passkey is registered");
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: credential.transports })),
    });
    const key = "authentication-challenges";
    await this.ctx.storage.transaction(async (transaction) => {
      const stored =
        (await transaction.get<AuthenticationChallenge[]>(key)) || [];
      const active = stored
        .filter((record) =>
          record.expiresAt > now && !same(record.ceremonyDigest, ceremonyDigest)
        );
      if (active.length >= AUTH_CHALLENGE_CAPACITY) {
        throw new Error("Authentication challenge capacity is exhausted");
      }
      active.push({
        ceremonyDigest,
        challenge: options.challenge,
        expiresAt: now + AUTH_CHALLENGE_SECONDS,
      });
      await transaction.put(key, active);
    });
    return options;
  }
  async completeAuthentication(
    response: AuthenticationResponseJSON,
    rpID: string,
    origin: string,
    ceremonyDigest: string,
    now: number,
  ) {
    const credentials = await this.credentials();
    const credential = credentials.find((candidate) => candidate.id === response.id);
    const key = "authentication-challenges";
    const challenge = await this.ctx.storage.transaction(async (transaction) => {
      const stored =
        (await transaction.get<AuthenticationChallenge[]>(key)) || [];
      const active = stored.filter((record) => record.expiresAt > now);
      const index = active.findIndex((record) =>
        same(record.ceremonyDigest, ceremonyDigest)
      );
      if (index < 0) {
        await transaction.put(key, active);
        return null;
      }
      const [claimed] = active.splice(index, 1);
      await transaction.put(key, active);
      return claimed?.challenge || null;
    });
    if (!credential || !challenge) throw new Error("Authentication challenge expired");
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
      } satisfies WebAuthnCredential,
    });
    if (!result.verified) throw new Error("Authentication failed");
    await this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<StoredCredential[]>("credentials")) || credentials;
      const latest = current.find((candidate) => candidate.id === credential.id);
      if (!latest) throw new Error("Authentication credential was revoked");
      const nextCounter = result.authenticationInfo.newCounter;
      if (latest.counter !== 0 && nextCounter !== 0 && nextCounter <= latest.counter) {
        throw new Error("Authentication counter replayed");
      }
      latest.counter = nextCounter;
      await transaction.put(
        "credentials",
        current.map((candidate) => candidate.id === latest.id ? latest : candidate),
      );
    });
    await this.ctx.storage.delete("credential");
  }
}

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (value: string) => {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value))));
}
async function digest(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}
function same(a: string, b: string): boolean {
  const aa = enc.encode(a), bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
function safeNext(value: unknown): string {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const parsed = new URL(value, "https://local.invalid");
    if (parsed.origin !== "https://local.invalid") return "/";
    const next = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return next.startsWith("/__") ? "/" : next;
  } catch {
    return "/";
  }
}
function canonicalAgentPayload(fields: {
  v: number; kid: string; nonce: string; iat: number; exp: number;
  origin: string; next: string; workspace_id: string;
}) {
  return JSON.stringify({
    v: fields.v, kid: fields.kid, nonce: fields.nonce, iat: fields.iat, exp: fields.exp,
    origin: fields.origin, next: fields.next, workspace_id: fields.workspace_id,
  });
}
async function verifyAgentSignature(publicKey: string, payload: string, signature: string) {
  try {
    const key = await crypto.subtle.importKey(
      "raw", unb64(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, unb64(signature), enc.encode(payload),
    );
  } catch {
    return false;
  }
}
export async function readBoundedJson<T extends Record<string, unknown>>(
  request: Request,
  maxBytes: number,
): Promise<T | null> {
  const raw = await readBoundedBody(request, maxBytes);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as T
      : null;
  } catch {
    return null;
  }
}
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
async function readBoundedForm(
  request: Request,
  maxBytes: number,
): Promise<URLSearchParams | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith(
    "application/x-www-form-urlencoded",
  )) return null;
  const raw = await readBoundedBody(request, maxBytes);
  if (raw === null) return null;
  return new URLSearchParams(raw);
}
async function agentRateSource(request: Request): Promise<string> {
  const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return digest(source);
}
async function readAuthSession(
  request: Request,
  state: DurableObjectStub<AdminAuthState>,
  secret: string,
  audience: string,
  admin: string,
  allowEmployees: boolean,
  agentKeyId?: string,
  agentPublicKey?: string,
): Promise<AuthSession | null> {
  const session = await readSigned<AuthSession>(request, SESSION, secret);
  const now = Math.floor(Date.now() / 1000);
  if (
    !session ||
    session.aud !== audience ||
    session.expiresAt <= now ||
    !Number.isInteger(session.authzVersion) ||
    !Number.isInteger(session.authenticatedAt) ||
    session.authenticatedAt > now + 5 ||
    !await state.isAuthSessionValid(session.sid, session.authzVersion, now)
  ) return null;
  if (session.role === "admin" && session.email === admin) return session;
  if (allowEmployees && session.role === "employee" && employeeEmail(session.email) === session.email) return session;
  if (session.role === "agent" && agentPublicKey && agentKeyId &&
      session.email === `agent:${agentKeyId}`) return session;
  return null;
}
async function authSessionCookie(
  state: DurableObjectStub<AdminAuthState>,
  secret: string,
  fields: Pick<AuthSession, "email" | "role" | "aud">,
  now: number,
  seconds: number,
) {
  const payload: AuthSession = {
    ...fields,
    sid: randomToken(),
    authzVersion: await state.authzVersion(),
    authenticatedAt: now,
    expiresAt: now + seconds,
  };
  return signedCookie(SESSION, secret, payload, seconds);
}
async function readSpendGrant(
  request: Request,
  secret: string,
  session: AuthSession,
  audience: string,
  epoch: string | undefined,
  now: number,
): Promise<SpendGrant | null> {
  const grant = await readSigned<SpendGrant>(request, SPEND, secret);
  if (
    !grant ||
    !epoch ||
    grant.aud !== audience ||
    grant.epoch !== epoch ||
    grant.sid !== session.sid ||
    grant.authzVersion !== session.authzVersion ||
    grant.integration !== SPEND_INTEGRATION ||
    grant.effortCeiling !== "low" ||
    grant.createLimit !== 1 ||
    grant.expiresAt <= now ||
    grant.expiresAt > Math.min(session.expiresAt, now + SPEND_GRANT_SECONDS) ||
    !/^[A-Za-z0-9_-]{43}$/.test(grant.grantId)
  ) return null;
  return grant;
}
async function signedCookie(name: string, secret: string, payload: object, seconds: number) {
  const data = b64(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, data);
  return `${name}=${data}.${sig}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
async function readSigned<T>(request: Request, name: string, secret: string): Promise<T | null> {
  const match = request.headers.get("cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  if (!match) return null;
  const [data, sig] = match[1]!.split(".");
  if (!data || !sig || !same(await hmac(secret, data), sig)) return null;
  try { return JSON.parse(new TextDecoder().decode(unb64(data))) as T; } catch { return null; }
}
function csrf(request: Request): string | null {
  return request.headers.get("cookie")?.match(new RegExp(`(?:^|; )${CSRF}=([^;]+)`))?.[1] ?? null;
}
function csrfCookie(value: string) {
  return `${CSRF}=${value}; Max-Age=${SESSION_SECONDS}; Path=/; Secure; SameSite=Strict`;
}
function clear(name: string) {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
function page(body: string, token: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Nimble playground login</title><style>body{font:16px system-ui;max-width:520px;margin:12vh auto;padding:1rem;color:#163126}button,input{width:100%;padding:.8rem;margin:.5rem 0;box-sizing:border-box}button{background:#087848;color:white;border:0;border-radius:7px}</style><h1>Protected Nimble playground</h1><p>Use administrator passkey, Nimble employee email, or the registered local agent identity.</p>${body}`, {
    status,
    headers: { ...headers, "content-type": "text/html; charset=utf-8", "set-cookie": csrfCookie(token) },
  });
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json", ...extra } });
}
function agentActivationPage(): Response {
  const nonce = randomToken();
  const script = `const p=new URLSearchParams(location.hash.slice(1));const token=p.get('token')||'';history.replaceState(null,'','/__agent/activate');fetch('/__agent/activate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(async r=>{const b=await r.json();if(!r.ok)throw Error(b.error||'Agent sign-in failed');location=b.next||'/';}).catch(e=>document.querySelector('p').textContent=e.message);`;
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Nimble agent sign-in</title><p>Verifying single-use agent authentication…</p><script nonce="${nonce}">${script}</script>`,
    { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` } },
  );
}
function employeeMagicPage(token: string): Response {
  const nonce = randomToken();
  const script = `const p=new URLSearchParams(location.hash.slice(1));const body=new URLSearchParams({csrf:${JSON.stringify(token)},email:p.get('email')||'',token:p.get('token')||''});history.replaceState(null,'','/__auth/magic');fetch('/__auth/magic/verify',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body}).then(async r=>{if(r.redirected)location=r.url;else throw Error(await r.text());}).catch(e=>document.querySelector('p').textContent=e.message);`;
  return new Response(
    `<!doctype html><meta charset=utf-8><title>Nimble employee sign-in</title><p>Verifying single-use employee authentication…</p><script nonce="${nonce}">${script}</script>`,
    { headers: { ...headers, "content-type": "text/html; charset=utf-8", "set-cookie": csrfCookie(token), "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` } },
  );
}
function webauthnScript(mode: "register" | "authenticate", token: string) {
  return `<button id=passkey>${mode === "register" ? "Register passkey" : "Sign in with passkey"}</button><pre id=error></pre><script>
const b=v=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(v.length/4)*4,'=')),c=>c.charCodeAt(0));
const s=v=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
passkey.onclick=async()=>{try{let o=await fetch('/__auth/${mode}/options',{headers:{'x-csrf-token':'${token}'}}).then(r=>r.json());o.challenge=b(o.challenge);${mode === "register" ? "o.user.id=b(o.user.id);o.excludeCredentials=(o.excludeCredentials||[]).map(x=>({...x,id:b(x.id)}));let c=await navigator.credentials.create({publicKey:o});let body={id:c.id,rawId:s(c.rawId),type:c.type,response:{clientDataJSON:s(c.response.clientDataJSON),attestationObject:s(c.response.attestationObject),transports:c.response.getTransports?.()||[]},clientExtensionResults:c.getClientExtensionResults()};" : "o.allowCredentials=(o.allowCredentials||[]).map(x=>({...x,id:b(x.id)}));let c=await navigator.credentials.get({publicKey:o});let body={id:c.id,rawId:s(c.rawId),type:c.type,response:{clientDataJSON:s(c.response.clientDataJSON),authenticatorData:s(c.response.authenticatorData),signature:s(c.response.signature),userHandle:c.response.userHandle?s(c.response.userHandle):undefined},clientExtensionResults:c.getClientExtensionResults()};"}let r=await fetch('/__auth/${mode}/verify',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':'${token}'},body:JSON.stringify(body)});if(!r.ok)throw Error((await r.json()).error);location='/';}catch(e){error.textContent=e.message}}</script>`;
}

export function employeeAuthEnabled(env: AuthEnv): boolean {
  return env.AUTH_EMPLOYEE_ENABLED === "true";
}
function employeeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@nimbleway\.com$/.test(email) ? email : null;
}
function otpCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0]! % 1_000_000).padStart(6, "0");
}
function magicToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
async function sendLoginEmail(binding: NonNullable<AuthEnv["AUTH_EMAIL"]>, email: string, code: string, token: string, origin: string) {
  const link = `${origin}/__auth/magic#email=${encodeURIComponent(email)}&token=${token}`;
  const raw = [
    `From: Nimble Agent Playground <${AUTH_EMAIL_ADDRESS}>`,
    `To: ${email}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@auth.kadosh.dev>`,
    "Subject: Your Nimble sign-in code",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Auto-Submitted: auto-generated",
    "",
    `Open this single-use magic link: ${link}`,
    "",
    `Or enter this six-digit code: ${code}`,
    "",
    "This sign-in expires in 10 minutes.",
  ].join("\r\n");
  await binding.send(new EmailMessage(AUTH_EMAIL_ADDRESS, email, raw));
}
function employeeForms(token: string): string {
  return `<hr><p>Nimble employees can receive a single-use code or magic link.</p><form method=post action=/__auth/otp/request><input type=hidden name=csrf value="${token}"><label>Work email</label><input name=email type=email autocomplete=email required><button>Email sign-in link</button></form>`;
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<Response | {
  email: string;
  role: AuthSession["role"];
  keyId?: string;
  sid: string;
  expiresAt: number;
  spendGrant?: SpendGrant;
}> {
  if (!env.ADMIN_PASSKEY || !env.ADMIN_SESSION_SECRET || !env.ADMIN_EMAIL) {
    return json({ error: "auth secrets are not configured" }, 503);
  }
  const admin = adminEmail(env);
  const url = new URL(request.url);
  const state = env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("admin"));
  const rpID = env.AUTH_RP_ID || url.hostname;
  const origin = url.origin;
  const agentOrigin = `https://${rpID}`;
  const token = csrf(request) || b64(crypto.getRandomValues(new Uint8Array(24)));
  const validCsrf = () => {
    const cookieToken = csrf(request);
    const headerToken = request.headers.get("x-csrf-token");
    return Boolean(cookieToken && headerToken && same(cookieToken, headerToken));
  };
  const adminOnly = !employeeAuthEnabled(env);
  const now = Math.floor(Date.now() / 1000);

  if (url.pathname === "/__agent/challenge" && request.method === "POST") {
    if (!env.AGENT_AUTH_PUBLIC_KEY || !env.AGENT_AUTH_KEY_ID || !env.AGENT_AUTH_WORKSPACE_ID) {
      return json({ error: "agent authentication is not configured" }, 503);
    }
    if (!await state.allowAgentRequest(
      "challenge",
      await agentRateSource(request),
      await digest(env.AGENT_AUTH_KEY_ID),
      now,
    )) {
      return json({ error: "agent authentication rate limit exceeded" }, 429, {
        "retry-after": String(AGENT_RATE_WINDOW_SECONDS),
      });
    }
    const body = await readBoundedJson<{ next?: string }>(request, 1_024);
    if (!body) return json({ error: "invalid challenge request" }, 400);
    if (Object.keys(body).some((key) => key !== "next")) return json({ error: "invalid challenge request" }, 400);
    const payload = canonicalAgentPayload({
      v: 1, kid: env.AGENT_AUTH_KEY_ID, nonce: randomToken(), iat: now,
      exp: now + AGENT_CHALLENGE_SECONDS, origin: agentOrigin,
      next: safeNext(body.next), workspace_id: env.AGENT_AUTH_WORKSPACE_ID,
    });
    return json({ payload, challenge_token: await hmac(env.ADMIN_SESSION_SECRET, `agent-challenge\n${payload}`) });
  }
  if (url.pathname === "/__agent/exchange" && request.method === "POST") {
    if (!env.AGENT_AUTH_PUBLIC_KEY || !env.AGENT_AUTH_KEY_ID || !env.AGENT_AUTH_WORKSPACE_ID) {
      return json({ error: "agent authentication is not configured" }, 503);
    }
    if (!await state.allowAgentRequest(
      "exchange",
      await agentRateSource(request),
      await digest(env.AGENT_AUTH_KEY_ID),
      now,
    )) {
      return json({ error: "agent authentication rate limit exceeded" }, 429, {
        "retry-after": String(AGENT_RATE_WINDOW_SECONDS),
      });
    }
    const body = await readBoundedJson<{
      payload?: string; signature?: string; challenge_token?: string;
    }>(request, 4_096);
    if (!body) return json({ error: "invalid agent proof" }, 400);
    if (typeof body.payload !== "string" || typeof body.signature !== "string" ||
        typeof body.challenge_token !== "string" || body.payload.length > 2048 ||
        body.signature.length > 256 || body.challenge_token.length > 128 ||
        Object.keys(body).some((key) => !["payload", "signature", "challenge_token"].includes(key))) {
      return json({ error: "invalid agent proof" }, 400);
    }
    let fields: Record<string, unknown>;
    try { fields = JSON.parse(body.payload) as Record<string, unknown>; }
    catch { return json({ error: "invalid agent proof" }, 400); }
    const expected = canonicalAgentPayload({
      v: 1, kid: env.AGENT_AUTH_KEY_ID, nonce: String(fields.nonce || ""),
      iat: Number(fields.iat), exp: Number(fields.exp), origin: agentOrigin,
      next: safeNext(fields.next), workspace_id: env.AGENT_AUTH_WORKSPACE_ID,
    });
    const exp = Number(fields.exp), iat = Number(fields.iat), nonce = String(fields.nonce || "");
    if (body.payload !== expected || !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
        exp <= now || exp > now + AGENT_CHALLENGE_SECONDS ||
        iat < now - AGENT_CHALLENGE_SECONDS || iat > now + 5) {
      return json({ error: "expired or invalid agent proof" }, 401);
    }
    if (!same(body.challenge_token, await hmac(env.ADMIN_SESSION_SECRET, `agent-challenge\n${body.payload}`)) ||
        !await verifyAgentSignature(env.AGENT_AUTH_PUBLIC_KEY, body.payload, body.signature)) {
      return json({ error: "agent proof was rejected" }, 401);
    }
    if (!await state.consumeAgentNonce(nonce, exp, now)) return json({ error: "agent proof was already used" }, 401);
    const activation = randomToken();
    if (!await state.beginAgentActivation(
      activation,
      env.AGENT_AUTH_KEY_ID,
      safeNext(fields.next),
      now + AGENT_CHALLENGE_SECONDS,
      now,
    )) {
      return json({ error: "agent activation capacity is temporarily exhausted" }, 429, {
        "retry-after": String(AGENT_CHALLENGE_SECONDS),
      });
    }
    return json({ activation_url: `${agentOrigin}/__agent/activate#token=${activation}` });
  }
  if (url.pathname === "/__agent/activate" && request.method === "GET") return agentActivationPage();
  if (url.pathname === "/__agent/activate" && request.method === "POST") {
    if (!await state.allowAgentRequest(
      "activate",
      await agentRateSource(request),
      await digest(env.AGENT_AUTH_KEY_ID || "unconfigured-agent-key"),
      now,
    )) {
      return json({ error: "agent authentication rate limit exceeded" }, 429, {
        "retry-after": String(AGENT_RATE_WINDOW_SECONDS),
      });
    }
    const body = await readBoundedJson<{ token?: string }>(request, 256);
    if (!body) return json({ error: "invalid agent activation" }, 400);
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
      return json({ error: "invalid agent activation" }, 400);
    }
    const activation = await state.consumeAgentActivation(body.token, now);
    if (!activation) return json({ error: "agent activation is invalid, expired, or already used" }, 401);
    const response = json({ authenticated: true, next: activation.next });
    response.headers.append("set-cookie", await authSessionCookie(
      state,
      env.ADMIN_SESSION_SECRET,
      { email: `agent:${activation.keyId}`, role: "agent", aud: rpID },
      now,
      AGENT_SESSION_SECONDS,
    ));
    response.headers.append("set-cookie", csrfCookie(token));
    return response;
  }

  const session = await readAuthSession(
    request,
    state,
    env.ADMIN_SESSION_SECRET,
    rpID,
    admin,
    !adminOnly,
    env.AGENT_AUTH_KEY_ID,
    env.AGENT_AUTH_PUBLIC_KEY,
  );
  if (session) {
    if (url.pathname.startsWith("/__auth/passkeys/add")) {
      return json({ error: "backup passkey enrollment is not available" }, 404);
    }
    if (
      url.pathname === CREATE_DIAGNOSTIC_READ_PATH &&
      request.method === "POST"
    ) {
      if (!validCsrf()) return json({ error: "invalid csrf" }, 403);
      if (
        session.role !== "agent" ||
        !env.AGENT_AUTH_KEY_ID ||
        session.email !== `agent:${env.AGENT_AUTH_KEY_ID}`
      ) {
        return json({ error: "not found" }, 404);
      }
      const body = await readBoundedJson<{ requestId?: string }>(
        request,
        1_024,
      );
      if (
        !body ||
        !CHAT_REQUEST_ID_PATTERN.test(String(body.requestId || "")) ||
        Object.keys(body).some((key) => key !== "requestId")
      ) {
        return json({ error: "invalid diagnostic request" }, 400);
      }
      const diagnostic = await state.readCreateDiagnostic(
        session.sid,
        body.requestId!,
        now,
      );
      if (diagnostic.kind === "receipt") {
        return json(
          { diagnostic: diagnostic.receipt },
          200,
          { "cache-control": "private, no-store" },
        );
      }
      return diagnostic.kind === "none"
        ? new Response(null, {
            status: 204,
            headers: { "cache-control": "private, no-store" },
          })
        : json(
            { error: "not found" },
            404,
            { "cache-control": "private, no-store" },
          );
    }
    if (url.pathname === "/__auth/spend/authorize" && request.method === "POST") {
      if (!validCsrf()) return json({ error: "invalid csrf" }, 403);
      if (
        session.role !== "agent" ||
        !env.AGENT_AUTH_KEY_ID ||
        session.email !== `agent:${env.AGENT_AUTH_KEY_ID}`
      ) {
        return json({ error: "only the registered agent session can authorize this run" }, 403);
      }
      const epoch = env.SPEND_GRANT_EPOCH?.trim();
      if (!epoch || spendEpochGeneration(epoch) === null) {
        return json({ error: "one-run authorization is not configured" }, 503);
      }
      const body = await readBoundedJson<{
        integration?: string;
        effortCeiling?: string;
        createLimit?: number;
      }>(request, 1_024);
      if (
        !body ||
        body.integration !== SPEND_INTEGRATION ||
        body.effortCeiling !== "low" ||
        body.createLimit !== 1 ||
        Object.keys(body).some((key) =>
          !["integration", "effortCeiling", "createLimit"].includes(key)
        )
      ) {
        return json({ error: "invalid one-run authorization request" }, 400);
      }
      const grantId = randomToken();
      const expiresAt = Math.min(session.expiresAt, now + SPEND_GRANT_SECONDS);
      if (!await state.issueSpendGrant(epoch, session.sid, grantId, expiresAt, now)) {
        return json({ error: "the configured one-run budget is already authorized" }, 409);
      }
      const grant: SpendGrant = {
        grantId,
        sid: session.sid,
        authzVersion: session.authzVersion,
        aud: rpID,
        epoch,
        integration: SPEND_INTEGRATION,
        effortCeiling: "low",
        createLimit: 1,
        expiresAt,
      };
      return json(
        {
          authorized: true,
          integration: grant.integration,
          effortCeiling: grant.effortCeiling,
          createLimit: grant.createLimit,
          expiresAt: grant.expiresAt,
        },
        200,
        {
          "set-cookie": await signedCookie(
            SPEND,
            env.ADMIN_SESSION_SECRET,
            grant,
            Math.max(1, expiresAt - now),
          ),
        },
      );
    }
    if (url.pathname.startsWith("/__auth/spend/")) {
      return json({ error: "method not allowed" }, 405);
    }
    if (url.pathname === "/__auth/logout" && request.method === "POST") {
      if (!validCsrf()) return json({ error: "invalid csrf" }, 403);
      await state.revokeAuthSession(session.sid, session.expiresAt, now);
      const response = new Response(null, {
        status: 303,
        headers: { ...headers, location: "/__auth/login" },
      });
      response.headers.append("set-cookie", clear(SESSION));
      response.headers.append("set-cookie", clear(SPEND));
      return response;
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      (url.pathname.startsWith("/tools/") || url.pathname.startsWith("/api/")) &&
      !validCsrf()
    ) {
      return json({ error: "invalid csrf" }, 403);
    }
    if (url.pathname === "/__auth/status") return json({
      authenticated: true, role: session.role,
      email: session.role === "agent" ? undefined : session.email,
      keyId: session.role === "agent" ? session.email.slice("agent:".length) : undefined,
      expiresAt: session.expiresAt,
    });
    const spendGrant = await readSpendGrant(
      request,
      env.ADMIN_SESSION_SECRET,
      session,
      rpID,
      env.SPEND_GRANT_EPOCH?.trim(),
      now,
    );
    return {
      email: session.email,
      role: session.role,
      keyId: session.role === "agent" ? session.email.slice("agent:".length) : undefined,
      sid: session.sid,
      expiresAt: session.expiresAt,
      ...(spendGrant ? { spendGrant } : {}),
    };
  }
  const hasPasskey = await state.hasPasskey();
  if (url.pathname.startsWith("/__auth/passkeys/add")) return json({ error: "not authorized" }, 403);
  if (url.pathname.startsWith(CREATE_DIAGNOSTIC_READ_PATH)) {
    return json({ error: "not found" }, 404);
  }
  if (url.pathname.startsWith("/__auth/spend/")) return json({ error: "not authorized" }, 403);
  if (adminOnly && (url.pathname.startsWith("/__auth/otp/") || url.pathname.startsWith("/__auth/magic"))) {
    return json({ error: "not found" }, 404);
  }
  if (url.pathname === "/__auth/otp/request" && request.method === "POST") {
    const form = await readBoundedForm(request, 2_048);
    if (!form) return json({ error: "invalid sign-in request" }, 400);
    if (String(form.get("csrf") || "") !== csrf(request)) return json({ error: "invalid csrf" }, 403);
    if (!env.AUTH_EMAIL) return json({ error: "employee email authentication is not configured" }, 503);
    const email = employeeEmail(String(form.get("email") || ""));
    if (!email) return json({ error: "use an official @nimbleway.com email" }, 400);
    if (!await state.allowOtpRequest(
      await digest(email),
      await agentRateSource(request),
      now,
    )) {
      return json({ error: "email sign-in rate limit exceeded" }, 429, {
        "retry-after": String(OTP_RATE_WINDOW_SECONDS),
      });
    }
    const code = otpCode();
    const linkToken = magicToken();
    const started = await state.beginOtp(
      email,
      await hmac(env.ADMIN_SESSION_SECRET, `otp\n${email}\n${code}`),
      await hmac(env.ADMIN_SESSION_SECRET, `magic\n${email}\n${linkToken}`),
      now,
    );
    if (!started.accepted) {
      return json(
        {
          error: started.capacity
            ? "email sign-in is temporarily at capacity"
            : "code already sent",
          retryAfter: started.retryAfter,
        },
        429,
      );
    }
    try { await sendLoginEmail(env.AUTH_EMAIL, email, code, linkToken, agentOrigin); }
    catch { await state.clearOtp(email); return json({ error: "login email could not be delivered" }, 502); }
    return page(`<p>Check ${email} for a code or magic link.</p><form method=post action=/__auth/otp/verify><input type=hidden name=csrf value="${token}"><input type=hidden name=email value="${email}"><input name=code inputmode=numeric pattern="[0-9]{6}" required><button>Verify code</button></form>`, token);
  }
  if (url.pathname === "/__auth/otp/verify" && request.method === "POST") {
    const form = await readBoundedForm(request, 2_048);
    if (!form) return json({ error: "invalid sign-in request" }, 400);
    if (String(form.get("csrf") || "") !== csrf(request)) return json({ error: "invalid csrf" }, 403);
    const email = employeeEmail(String(form.get("email") || ""));
    const code = String(form.get("code") || "").replace(/\D/g, "");
    if (!email || !/^\d{6}$/.test(code)) return json({ error: "invalid email or code" }, 400);
    const ok = await state.verifyOtp(email, await hmac(env.ADMIN_SESSION_SECRET, `otp\n${email}\n${code}`), Math.floor(Date.now() / 1000));
    if (!ok) return json({ error: "invalid or expired code" }, 401);
    return new Response(null, {
      status: 303,
      headers: {
        ...headers,
        location: "/",
        "set-cookie": await authSessionCookie(
          state,
          env.ADMIN_SESSION_SECRET,
          { email, role: "employee", aud: rpID },
          now,
          SESSION_SECONDS,
        ),
      },
    });
  }
  if (url.pathname === "/__auth/magic" && request.method === "GET") {
    return employeeMagicPage(token);
  }
  if (url.pathname === "/__auth/magic/verify" && request.method === "POST") {
    const form = await readBoundedForm(request, 2_048);
    if (!form) return json({ error: "invalid sign-in request" }, 400);
    if (String(form.get("csrf") || "") !== csrf(request)) return json({ error: "invalid csrf" }, 403);
    const email = employeeEmail(String(form.get("email") || ""));
    const linkToken = String(form.get("token") || "");
    if (!email || !/^[A-Za-z0-9_-]{43}$/.test(linkToken)) return json({ error: "invalid magic link" }, 400);
    const ok = await state.verifyMagicLink(email, await hmac(env.ADMIN_SESSION_SECRET, `magic\n${email}\n${linkToken}`), Math.floor(Date.now() / 1000));
    if (!ok) return json({ error: "invalid or expired magic link" }, 401);
    return new Response(null, {
      status: 303,
      headers: {
        ...headers,
        location: "/",
        "set-cookie": await authSessionCookie(
          state,
          env.ADMIN_SESSION_SECRET,
          { email, role: "employee", aud: rpID },
          now,
          SESSION_SECONDS,
        ),
      },
    });
  }
  if (url.pathname === "/__auth/bootstrap" && request.method === "POST") {
    if (!await state.allowAgentRequest(
      "bootstrap",
      await agentRateSource(request),
      await digest("bootstrap-global"),
      now,
    )) {
      return json({ error: "bootstrap rate limit exceeded" }, 429, {
        "retry-after": String(AGENT_RATE_WINDOW_SECONDS),
      });
    }
    const body = await readBoundedForm(request, 2_048);
    if (!body) return json({ error: "invalid bootstrap request" }, 400);
    if (hasPasskey || String(body.get("csrf") || "") !== csrf(request)) return json({ error: "bootstrap unavailable" }, 403);
    if (!same(String(body.get("password") || ""), env.ADMIN_PASSKEY)) return page(`<p>Incorrect temporary password.</p><form method=post action=/__auth/bootstrap><input type=hidden name=csrf value="${token}"><input type=password name=password><button>Continue</button></form>`, token, 401);
    return new Response(null, { status: 303, headers: { ...headers, location: "/__auth/setup", "set-cookie": await signedCookie(BOOTSTRAP, env.ADMIN_SESSION_SECRET, { email: admin, exp: Date.now() + BOOTSTRAP_SECONDS * 1000 }, BOOTSTRAP_SECONDS) } });
  }
  const boot = await readSigned<{ email: string; exp: number }>(request, BOOTSTRAP, env.ADMIN_SESSION_SECRET);
  if (url.pathname === "/__auth/register/options" && request.method === "GET") {
    if (!validCsrf() || hasPasskey || boot?.email !== admin || boot.exp <= Date.now()) return json({ error: "not authorized" }, 403);
    return json(await state.registrationOptions(rpID));
  }
  if (url.pathname === "/__auth/register/verify" && request.method === "POST") {
    if (!validCsrf() || hasPasskey || boot?.email !== admin || boot.exp <= Date.now()) return json({ error: "not authorized" }, 403);
    const registration = await readBoundedJson<Record<string, unknown>>(request, 64 * 1_024);
    if (!registration) return json({ error: "invalid registration response" }, 400);
    try {
      await state.completeRegistration(
        registration as unknown as RegistrationResponseJSON,
        rpID,
        origin,
      );
    }
    catch (error) { return json({ error: error instanceof Error ? error.message : "registration failed" }, 400); }
    return json({ verified: true }, 200, {
      "set-cookie": await authSessionCookie(
        state,
        env.ADMIN_SESSION_SECRET,
        { email: admin, role: "admin", aud: rpID },
        now,
        SESSION_SECONDS,
      ),
    });
  }
  if (url.pathname === "/__auth/authenticate/options" && request.method === "GET") {
    if (!validCsrf() || !hasPasskey) return json({ error: "not authorized" }, 403);
    if (!await state.allowAgentRequest(
      "passkey-options",
      await agentRateSource(request),
      await digest("admin-passkey"),
      now,
    )) {
      return json({ error: "passkey rate limit exceeded" }, 429, {
        "retry-after": String(AGENT_RATE_WINDOW_SECONDS),
      });
    }
    return json(await state.authenticationOptions(
      rpID,
      await digest(csrf(request)!),
      now,
    ));
  }
  if (url.pathname === "/__auth/authenticate/verify" && request.method === "POST") {
    if (!validCsrf() || !hasPasskey) return json({ error: "not authorized" }, 403);
    if (!await state.allowAgentRequest(
      "passkey-verify",
      await agentRateSource(request),
      await digest("admin-passkey"),
      now,
    )) {
      return json({ error: "passkey rate limit exceeded" }, 429, {
        "retry-after": String(AGENT_RATE_WINDOW_SECONDS),
      });
    }
    const assertion = await readBoundedJson<Record<string, unknown>>(request, 64 * 1_024);
    if (!assertion) return json({ error: "invalid authentication response" }, 400);
    try {
      await state.completeAuthentication(
        assertion as unknown as AuthenticationResponseJSON,
        rpID,
        origin,
        await digest(csrf(request)!),
        now,
      );
    }
    catch (error) { return json({ error: error instanceof Error ? error.message : "authentication failed" }, 401); }
    return json({ verified: true }, 200, {
      "set-cookie": await authSessionCookie(
        state,
        env.ADMIN_SESSION_SECRET,
        { email: admin, role: "admin", aud: rpID },
        now,
        SESSION_SECONDS,
      ),
    });
  }
  if (url.pathname === "/__auth/setup" && !hasPasskey && boot?.email === admin && boot.exp > Date.now()) return page(webauthnScript("register", token), token);
  if (url.pathname === "/__auth/status") return json({ authenticated: false }, 401);
  if (url.pathname === "/__auth/login" || url.pathname === "/") {
    return hasPasskey
      ? page(`${webauthnScript("authenticate", token)}${adminOnly ? "" : employeeForms(token)}`, token)
      : page(`<form method=post action=/__auth/bootstrap><input type=hidden name=csrf value="${token}"><label>One-time administrator bootstrap password</label><input type=password name=password autocomplete=current-password><button>Continue</button></form>${adminOnly ? "" : employeeForms(token)}`, token);
  }
  if (url.pathname.startsWith("/tools/") || url.pathname.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
  return new Response(null, { status: 303, headers: { ...headers, location: "/__auth/login" } });
}
