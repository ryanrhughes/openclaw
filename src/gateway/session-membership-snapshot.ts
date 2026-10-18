/**
 * Main-thread view of the resident session membership projection. Sharing filters read
 * published membership facts here instead of querying SQLite; unknown means "not a member".
 */
type SessionMembershipSnapshotReader = {
  membership(storePath: string, sessionKey: string): readonly string[] | undefined;
  membershipForSessionKey(sessionKey: string): readonly string[] | undefined;
};

let current: WeakRef<SessionMembershipSnapshotReader> | undefined;

export function publishSessionMembershipSnapshot(reader: SessionMembershipSnapshotReader): void {
  current = new WeakRef(reader);
}

export function readSessionMembershipSnapshot(params: {
  sessionKey: string;
  storePath?: string;
}): readonly string[] | undefined {
  const reader = current?.deref();
  if (!reader) {
    return undefined;
  }
  return (
    (params.storePath ? reader.membership(params.storePath, params.sessionKey) : undefined) ??
    reader.membershipForSessionKey(params.sessionKey)
  );
}
