/**
 * 可信网络：把来自本机和指定网段（默认 Tailscale）的请求当作本机请求，其余来源一律拒绝。
 *
 * 由环境变量 TOONFLOW_TRUSTED_NETWORKS 开启，未设置时与上游行为完全一致：
 *   TOONFLOW_TRUSTED_NETWORKS=tailscale                  # Tailscale 的 100.64.0.0/10 与 fd7a:115c:a1e0::/48
 *   TOONFLOW_TRUSTED_NETWORKS=tailscale,10.8.0.0/24      # 逗号分隔，可混写 CIDR 或单个 IP
 * 本机回环地址始终可信（含 tailscale serve 等本机反向代理转发来的请求）。
 *
 * 防 DNS 重绑定：只认来源 IP 还不够，还要求访问用的主机名是 IP、localhost、不带点的 MagicDNS 短名或 *.ts.net，
 * 否则可信设备上的恶意网页可以把自己的域名解析到本机后冒充本机页面。
 */
import type { NextFunction, Request, Response } from "express";
import { BlockList, isIP } from "node:net";

const aliases: Record<string, string[]> = { tailscale: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"] };

function parseNetworks(value: string) {
  const networks = new BlockList();
  networks.addSubnet("127.0.0.0", 8, "ipv4");
  networks.addAddress("::1", "ipv6");
  for (const item of value.split(",").flatMap(part => aliases[part.trim().toLowerCase()] ?? [part.trim()]).filter(Boolean)) {
    const [address, prefix] = item.split("/");
    const family = isIP(address ?? "");
    if (!family) throw new Error(`TOONFLOW_TRUSTED_NETWORKS 中的地址无效：${item}`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) networks.addAddress(address!, type);
    else networks.addSubnet(address!, Number(prefix), type);
  }
  return networks;
}

const setting = process.env.TOONFLOW_TRUSTED_NETWORKS?.trim();
const networks = setting ? parseNetworks(setting) : undefined;

/** 是否启用了可信网络模式。 */
export const trustedNetworkEnabled = !!networks;

function remoteAddress(req: Request) {
  const address = req.socket.remoteAddress ?? "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function trustedHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !!isIP(host) || host === "localhost" || !host.includes(".") || host.endsWith(".ts.net");
}

function trustedAddress(address: string) {
  const family = isIP(address);
  return !!networks && !!family && networks.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** 来自可信网络、且通过可信主机名访问的请求，享有与本机相同的权限。 */
export function isTrustedNetworkRequest(req: Request) {
  return trustedAddress(remoteAddress(req)) && trustedHost(req.hostname);
}

/** 拒绝可信网络以外的来源；未开启可信网络模式时直接放行。 */
export function trustedNetworkGuard(req: Request, res: Response, next: NextFunction) {
  if (!networks || trustedAddress(remoteAddress(req))) return next();
  res.status(403).type("text/plain; charset=utf-8").send("此 Toonflow 只允许本机和 Tailscale 设备访问");
}

/** 可信请求浏览目录时的根目录（TOONFLOW_BROWSE_ROOT）；未设置时沿用上游的服务器工作区。 */
export function trustedBrowseRoot(req: Request) {
  const root = process.env.TOONFLOW_BROWSE_ROOT?.trim();
  return root && isTrustedNetworkRequest(req) ? root : undefined;
}
