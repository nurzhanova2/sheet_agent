export interface AuthContext { readonly userId: string; readonly tenantId: string; readonly scopes?: readonly string[]; }
export type TokenVerifier = (token: string) => Promise<AuthContext | undefined>;

export async function authenticate(request: Request, verifyToken: TokenVerifier): Promise<AuthContext | undefined> {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return undefined;
  return verifyToken(value.slice(7).trim());
}
