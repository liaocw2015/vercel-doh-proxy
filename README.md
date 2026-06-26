# Vercel DoH Proxy

这是一个部署在 Vercel 边缘网络上的高性能、低延迟 DNS-over-HTTPS (DoH) 代理服务。

它旨在利用 Vercel 全球分布的边缘节点为用户的 DNS 查询提供加速，同时集成了智能的 ECS (EDNS Client Subnet) 处理和灵活的上游路由策略。项目还附带一个现代化的在线 DNS 查询工具，方便在线使用。

---

## ✨ 项目特点

-   **边缘加速**: 完全部署在 Vercel Edge Functions 上，自动将用户的 DNS 查询路由到最近的边缘节点，显著降低延迟。
-   **智能 ECS 处理**:
    -   可自动从请求头中提取客户端 IP，为不支持 ECS 的 DoH 客户端附加 EDNS Client Subnet 信息，以获得更精确的地理位置解析结果。
    -   能够智能识别请求中是否已包含 ECS，并将请求路由到不同的上游 DoH 服务器（例如，带 ECS 的请求发往 Google Public DNS，不带的则发往 Cloudflare DNS），根据不同场景分流保护客户端隐私。
-   **高度可配置**: 通过环境变量，可以轻松定制：
    -   多个常规、ECS 和 JSON API 的上游 DoH 服务器。
    -   全局是否开启自动 ECS 附加。
    -   ECS 中使用的 IP 地址掩码长度。
    -   是否强制对 `dns-message` 响应进行 RFC 8467 填充以增强隐私。
-   **并发上游请求**: 同时向上游列表中的所有服务器发起请求，并采用最快返回的有效响应，提升了服务的健壮性和响应速度。
-   **现代化前端**:
    -   提供一个美观且用户友好的在线 DNS 查询页面。
    -   支持丰富的 DNS 记录类型查询，并对 A, AAAA, MX, SRV, CAA, TXT 等常见记录进行格式化美化，使其更易于阅读。
-   **CDN 缓存优化**: 智能地为不同类型的 DoH 请求设置了不同的 `Cache-Control` 策略，有效利用 Vercel 的 CDN 缓存，进一步提升性能。
-   **纯前端构建**: 前端查询页面使用原生 JavaScript 构建，体积小巧，加载迅速。

## 🚀 如何使用

### DoH 代理服务

本项目提供三个主要的 DoH 端点，您可以将其配置在支持 DoH 的客户端、路由器或浏览器中：

-   **`/dns-query` (默认/推荐)**
    -   行为由环境变量 `AUTO_ADD_ECS` 控制。
    -   默认情况下，如果客户端请求不带 ECS，代理**不会**自动添加。
    -   如果请求本身包含 ECS，或者代理自动添加了 ECS，请求将被转发到配置的 `ECS_UPSTREAM_DOH_URLS`。否则，转发到 `UPSTREAM_DOH_URLS`。

-   **`/dns-query/auto_ecs` (强制自动 ECS)**
    -   无论全局配置如何，此端点都会尝试为不带 ECS 的请求自动附加客户端子网信息。
    -   适用于需要精确地理位置解析，但客户端本身不支持发送 ECS 的场景。

-   **`/dns-query/no_ecs` (强制禁用 ECS)**
    -   无论全局配置如何，此端点都**不会**自动附加 ECS，并将所有请求转发到常规上游。
    -   适用于注重隐私、不希望泄露任何客户端子网信息的场景。

### 在线 DNS 查询工具

直接访问您部署的 Vercel 域名（例如 `https://your-project.vercel.app/`），即可使用在线查询工具。

1.  输入您要查询的**域名**。
2.  选择或输入**记录类型** (如 A, AAAA, MX, CNAME 等)。
3.  点击“查询”按钮，结果将以格式化的表格形式显示在下方。

## ⚙️ 技术实现

-   **Vercel Edge Functions**: 整个后端代理逻辑 (`doh.js`) 运行在 Vercel 的边缘网络上，实现了低延迟和高可用性。
-   **原生 JavaScript & Fetch API**:
    -   前端 (`script.js`) 使用原生 JS 和 Fetch API 与后端进行交互，无需任何重型框架。
    -   后端 (`doh.js`) 同样使用 Fetch API 与上游 DoH 服务器通信。
-   **二进制处理**: 后端代码能够高效地解析和操作 `application/dns-message` 格式的二进制 DNS 报文，包括检查、添加 EDNS(0) OPT 记录和 ECS 选项。

## 🛠️ 自行部署

1.  **Fork 本仓库**: 点击页面右上角的 "Fork" 按钮。

2.  **部署到 Vercel**:
    -   访问 [Vercel](https://vercel.com/) 并使用您的 GitHub 账户登录。
    -   点击 "Add New... -> Project"，选择您刚刚 Fork 的仓库。
    -   Vercel 会自动识别这是一个无需构建步骤的静态项目（带边缘函数），直接点击 "Deploy" 即可。

3.  **(可选) 配置环境变量**:
    -   在 Vercel 项目的 "Settings" -> "Environment Variables" 中，您可以添加以下变量来定制代理行为：
    -   **`UPSTREAM_DOH_URLS`**: 常规 DoH 上游，用逗号分隔。默认为 `https://cloudflare-dns.com/dns-query`。
    -   **`ECS_UPSTREAM_DOH_URLS`**: 支持 ECS 的 DoH 上游。默认为 `https://dns.google/dns-query`。
    -   **`JSON_UPSTREAM_DOH_URLS`**: 用于前端页面的 JSON API 上游。默认为 `https://dns.google/resolve`。
    -   **`AUTO_ADD_ECS`**: 是否全局为不带 ECS 的请求自动附加子网信息。设为 `true` 开启。默认为 `false`。
    -   **`IPV4_ECS_PREFIX_LENGTH`**: 自动附加 ECS 时，IPv4 地址使用的前缀长度。默认为 `24`。
    -   **`IPV6_ECS_PREFIX_LENGTH`**: 自动附加 ECS 时，IPv6 地址使用的前缀长度。默认为 `56`。
    -   **`FORCE_RESPONSE_PADDING`**: 是否强制对 `dns-message` 响应进行填充。设为 `true` 开启。默认为 `false`。
    -   **`DEBUG_LOGGING`**: 是否在 Vercel 的函数日志中输出详细的调试信息。设为 `true` 开启。默认为 `false`。


## 🤝 贡献

欢迎通过 Pull Requests 或 Issues 为本项目做出贡献。
