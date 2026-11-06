/** 本地化 fork 挂到上游 app.ts 的全部中间件，只占上游一行；各项由各自的环境变量开启。 */
import { trustedNetworkGuard } from "./trustedNetwork";
import { staticCompression } from "./staticCompression";
import "./memoryWatch";

export const localMiddleware = [trustedNetworkGuard, staticCompression];
