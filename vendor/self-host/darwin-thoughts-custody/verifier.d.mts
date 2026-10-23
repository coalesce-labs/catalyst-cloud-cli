// Generated from canonical protocol and consumer source. Do not edit.

export interface DarwinThoughtsAuthority {
  readonly version: 1;
  readonly installationId: string;
  /** Canonical base64 DER SPKI for an Ed25519 public key. Never selected by a response. */
  readonly publicKey: string;
  readonly nativeUid: number;
  readonly nativeGid: number;
  readonly nativeHome: string;
  readonly endpoint: string;
  readonly daemonId: string;
  readonly thoughtsRoot: string;
  readonly locksRoot: string;
  readonly requestsRoot: string;
  readonly responsesRoot: string;
}

export interface DarwinThoughtsSessionCustody {
  readonly kind: "darwin-native-v1";
  readonly authority: DarwinThoughtsAuthority;
}

export interface DarwinThoughtsRequest {
  readonly version: 1;
  readonly installationId: string;
  readonly nonce: string;
  readonly tenant: string;
  readonly repository: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface DarwinThoughtsStatIdentity {
  /** Logical native source, even when an Engine helper observes an alias. */
  readonly path: string;
  /** Canonical unsigned 64-bit decimal strings avoid JavaScript inode precision loss. */
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
  /** Permission and special bits, excluding the file-type bits. */
  readonly mode: number;
  readonly isDirectory: true;
  readonly isSymbolicLink: false;
}

interface DarwinThoughtsResponseBinding {
  readonly version: 1;
  readonly authority: DarwinThoughtsAuthority;
  readonly request: DarwinThoughtsRequest;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly nativeBootId: string;
  readonly producerInstance: string;
}

export interface DarwinThoughtsAcceptedResponse extends DarwinThoughtsResponseBinding {
  readonly kind: "accepted";
  readonly nativeCheckout: DarwinThoughtsStatIdentity;
  readonly nativeLock: DarwinThoughtsStatIdentity;
  readonly engineCheckout: DarwinThoughtsStatIdentity;
  readonly engineLock: DarwinThoughtsStatIdentity;
  readonly nativeGit?: DarwinThoughtsStatIdentity;
  readonly engineGit?: DarwinThoughtsStatIdentity;
}

export interface DarwinThoughtsRefusedResponse extends DarwinThoughtsResponseBinding {
  readonly kind: "refused";
  /** Bounded machine code only. No filesystem contents, credentials or descriptive output. */
  readonly reason: string;
}

export type DarwinThoughtsResponse = DarwinThoughtsAcceptedResponse | DarwinThoughtsRefusedResponse;

export interface DarwinThoughtsSignedEnvelope {
  readonly version: 1;
  /** The exact UTF-8 payload bytes are signed; parsing must not replace those bytes. */
  readonly payload: string;
  readonly signature: string;
}

export interface DarwinThoughtsTargets {
  readonly checkoutSource: string;
  readonly lockSource: string;
  readonly requestSource: string;
  readonly responseSource: string;
  readonly publicCheckoutTarget: string;
  readonly privateCheckoutTarget: string;
  readonly privateLockTarget: string;
  readonly privateRequestTarget: string;
  readonly privateResponseTarget: string;
}

type AcceptedResponse = Extract<DarwinThoughtsResponse, { kind: "accepted" }>;

export interface DarwinThoughtsCustodyExpectation {
  authority: DarwinThoughtsAuthority;
  request: DarwinThoughtsRequest;
  nowMs: number;
  engineCheckout: DarwinThoughtsStatIdentity;
  engineLock: DarwinThoughtsStatIdentity;
  engineGit?: DarwinThoughtsStatIdentity;
}

export interface FreshDarwinThoughtsCustodyOptions {
  authority: DarwinThoughtsAuthority;
  tenant: string;
  repository: string;
  requestDir: string;
  responseDir: string;
  checkoutPath: string;
  lockPath: string;
  gitPath?: string;
  /** Absolute wall-clock deadline, bounded to one protocol exchange. */
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Synchronous trusted receiving only, after signature, actual descriptors and deadline. */
  onProof?: (receipt: {
    bytes: Buffer;
    proof: AcceptedResponse;
    expectation: DarwinThoughtsCustodyExpectation;
  }) => void;
}

export declare function canonicalDarwinThoughtsJson(value: unknown): string;

export declare function deriveDarwinThoughtsTargets(
  authority: DarwinThoughtsAuthority,
  tenant: string,
  repository: string,
): DarwinThoughtsTargets;

export declare function parseDarwinThoughtsAuthority(value: unknown): DarwinThoughtsAuthority;

export declare function parseDarwinThoughtsRequest(value: unknown): DarwinThoughtsRequest;

export declare function parseDarwinThoughtsResponse(
  value: unknown,
  context: { authority: DarwinThoughtsAuthority; request: DarwinThoughtsRequest; nowMs: number },
): DarwinThoughtsResponse;

export declare function parseDarwinThoughtsSignedEnvelope(value: unknown): DarwinThoughtsSignedEnvelope;

export declare function requestFreshDarwinThoughtsBootstrap(
  options: FreshDarwinThoughtsCustodyOptions,
): Promise<AcceptedResponse>;

export declare function requestFreshDarwinThoughtsCustody(
  options: FreshDarwinThoughtsCustodyOptions,
): Promise<AcceptedResponse>;

export declare function verifyDarwinThoughtsCustodyResponse(
  bytes: Uint8Array,
  expected: DarwinThoughtsCustodyExpectation,
): AcceptedResponse;
