import { requireUser, send } from "./_claude.js";
import { account } from "./_account.js";

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user || !user.id) return send(res, 401, { error: "auth_required" });
  send(res, 200, account(user));
}
