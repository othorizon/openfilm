# 中国境内部署

此目录部署 OpenFilm 云 API 和 PostgreSQL，适用于 Dokploy 的 Docker Compose。
素材存储在阿里云 OSS，客户端直传；剪辑、渲染和草稿打包仍在用户电脑上完成。
云端无需安装 Electron、浏览器或 FFmpeg。

## 加速源

| 下载内容 | 默认来源 | 覆盖变量 |
| --- | --- | --- |
| Node.js 基础镜像 | DaoCloud 的 Docker Hub 镜像 | `NODE_IMAGE` |
| PostgreSQL 镜像 | DaoCloud 的 Docker Hub 镜像 | `POSTGRES_IMAGE` |
| Debian 系统包 | 清华 TUNA Debian 镜像 | `DEBIAN_MIRROR` |
| Debian 安全更新 | 清华 TUNA Debian Security 镜像 | `DEBIAN_SECURITY_MIRROR` |
| Corepack 下载 pnpm、npm/pnpm 依赖 | npmmirror | `NPM_REGISTRY` |

镜像使用 [DaoCloud 官方的前缀映射方式](https://github.com/DaoCloud/public-image-mirror)。
系统包源遵循 [TUNA Debian 说明](https://mirrors.tuna.tsinghua.edu.cn/help/debian/)；
pnpm 本身通过 [Corepack 的 `COREPACK_NPM_REGISTRY`](https://github.com/nodejs/corepack#environment-variables)
下载，依赖通过 [npmmirror](https://npmmirror.com/) 下载。包管理器版本遵循根目录
`package.json`，依赖遵循 `pnpm-lock.yaml`，保留 TLS、Debian 签名和包完整性校验。

Dockerfile 使用 BuildKit 内置 frontend，避免额外从 Docker Hub 拉取
`docker/dockerfile`。Node slim 镜像缺少系统 CA 文件，因此先用 Node 内置的公共根证书
建立 HTTPS 信任，再从国内源安装 `ca-certificates`。APT 配置保留在镜像内，
后续新增系统包安装也使用同一镜像源。

公共镜像站可能限流或同步延迟；可在环境配置中替换上述变量。`NODE_IMAGE` 和
`POSTGRES_IMAGE` 接受完整镜像地址（包括版本或 digest），可指向自己的 ACR/Harbor。
`NODE_IMAGE` 应保持 Node 24 Debian Bookworm slim 兼容，PostgreSQL 保持 17 主版本。
这些配置只加速容器和包下载，不改变 Dokploy 从 GitHub 拉取源码的网络路径。

## Dokploy

1. 创建 Compose 服务，类型选择 **Docker Compose**。当前配置包含源码构建，
   不适用于不支持 `build` 的 Stack 模式。
2. 来源选择 GitHub/Git，仓库 `othorizon/openfilm`，分支 `feat/oss-cloud-library`。
3. **Compose Path** 填 `./deploy/cloud/cn/compose.yaml`。使用仓库来源而非直接粘贴 YAML，
   因为构建需要完整检出的源码。构建上下文已指向仓库根目录。
4. 把本目录 `env.example` 的内容复制到 **Environment**，替换数据库密码和 OSS 配置。
   数据库密码使用 `openssl rand -hex 32` 生成的十六进制字符串。真实密钥不要提交到 Git。
5. 在 **Domains** 添加域名，服务选择 `cloud`，容器端口填 `8080`，启用 HTTPS。
   将域名解析到 Dokploy 服务器。
6. 推荐开启 **Isolated Deployments**。用 **Preview Compose** 确认 `cloud` 和
   `postgres` 共享网络，且 `cloud` 可被 Dokploy 代理访问。本文件显式保留两者的
   `default` 网络，未映射任何宿主机端口。
7. 点击部署，等待两个服务健康，访问 `https://你的域名/health`。
8. 在包含云功能的 OpenFilm 客户端「设置 → 云账户」填入 `https://你的域名`，
   注册或登录。

域名和代理配置参考 [Dokploy 官方说明](https://docs.dokploy.com/docs/core/docker-compose/domains)。
无需另外安装 Caddy，也无需向公网开放 PostgreSQL。

## 手动使用 Compose

在仓库根目录执行（需要 Docker Compose v2 和 BuildKit）：

```sh
mkdir -p "$HOME/.config/openfilm"
cp deploy/cloud/cn/env.example "$HOME/.config/openfilm/cloud-cn.env"
chmod 600 "$HOME/.config/openfilm/cloud-cn.env"
# 编辑上面的文件，填写数据库密码与 OSS 配置。
docker compose -p openfilm-cloud-cn --env-file "$HOME/.config/openfilm/cloud-cn.env" \
  -f deploy/cloud/cn/compose.yaml up -d --build
docker compose -p openfilm-cloud-cn --env-file "$HOME/.config/openfilm/cloud-cn.env" \
  -f deploy/cloud/cn/compose.yaml exec -T cloud \
  node -e "fetch('http://127.0.0.1:8080/health').then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); })"
```

此文件仅在容器网络暴露 8080。手动部署需要自行接入反向代理网络；若代理在宿主机运行，
可在自己维护的 Compose override 中给 `cloud` 增加
`ports: ["127.0.0.1:8080:8080"]`。

需要单独构建 API 镜像时，在仓库根目录执行：

```sh
docker build -f deploy/cloud/cn/Dockerfile -t openfilm-cloud:cn .
```

企业构建代理需要自定义 CA 时，可附加
`--secret id=build_ca,src=/secure/combined-ca-bundle.pem`，文件需包含公共根证书及代理 CA。
该证书仅挂载到构建步骤，不写入镜像。普通 Dokploy 部署不需要此参数。

PostgreSQL 使用命名卷持久化，升级前备份数据库；不要对需要保留的数据执行
`down --volumes`。更换 Compose 项目名会使用新的卷，迁移已有部署时需显式接入原卷或
恢复备份。账户管理、OSS 配额和备份说明见 [云服务文档](../../../docs/cloud-service.md)。
