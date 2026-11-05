import { Router } from "express";
import { success } from "@/lib/responseFormat";
import type { HomeAdvertisements } from "@/utils/channel/types";

// 本地化 fork：不拉取官方云端的首页广告，页头横幅与侧栏推广均为空（见 local/readme.md）。
const advertisements: HomeAdvertisements = { banner: null, banners: [], bannerMode: "carousel", bannerInterval: 5, sidebar: [] };

export default Router().get("/", (_req, res) => res.json(success(advertisements)));
