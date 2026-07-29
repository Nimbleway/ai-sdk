export const CHAT_REQUEST_ID_HEADER = "x-chat-request-id";

type Transaction = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

export type TransactionalStorage = {
  transaction<T>(closure: (transaction: Transaction) => Promise<T>): Promise<T>;
};

export async function admitOnce(storage: TransactionalStorage): Promise<boolean> {
  return storage.transaction(async (transaction) => {
    if (await transaction.get("admitted")) return false;
    await transaction.put("admitted", {
      admittedAt: new Date().toISOString(),
      retryAllowed: false,
    });
    return true;
  });
}

export function validChatRequestId(value: string | null): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}
