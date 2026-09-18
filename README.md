# NasDocker

NasDocker 运行在 Docker 容器中，通过宿主机的 Docker Socket 管理容器、镜像和 Compose 项目。

当前功能：

- 查看容器状态、内存和“宿主机端口 → 容器端口”映射
- 启动、停止、暂停、恢复和重启容器
- 进入页面时检查正在使用的 `latest` 镜像，并升级容器
- 在 `/composeFile` 的子目录中创建或引用固定名称的 `docker-compose.yml`
- 同时执行前端 YAML 校验与 `docker compose config --quiet` 校验
- 部署、启动、停止和更新 Compose 项目
- 自动读取 Docker Engine 当前镜像源，并支持新增、编辑、启用和停用
- 应用内登录保护，同时保留 HTTP Basic 供 API 脚本使用

## 部署

服务器需要 Linux、Docker Engine 和 Docker Compose 插件。

```bash
cp .env.example .env
```

编辑 `.env`，至少修改 `NASDOCKER_PASSWORD`，并将 `COMPOSE_HOST_DIR` 指向宿主机保存 Compose 项目的目录。然后启动：

```bash
docker compose up -d --build
```

默认访问地址为 `http://服务器IP:3080`。在应用登录页输入 `.env` 中设置的用户名和密码。

宿主机目录映射关系：

| 宿主机 | 管理容器内 | 用途 |
|---|---|---|
| `/var/run/docker.sock` | `/var/run/docker.sock` | Docker Engine API |
| `COMPOSE_HOST_DIR` | `/composeFile` | Compose 项目文件 |
| Docker volume `nasdocker-data` | `/data` | NasDocker 镜像源列表等持久数据 |

例如页面中选择子目录 `media/jellyfin`，文件实际保存在：

```text
宿主机：${COMPOSE_HOST_DIR}/media/jellyfin/docker-compose.yml
容器内：/composeFile/media/jellyfin/docker-compose.yml
```

镜像源页面通过 Docker Engine 自动读取当前生效配置。点击“应用到宿主机”时，NasDocker 会通过 Docker Socket 启动一次性辅助容器，更新宿主机的 `/etc/docker/daemon.json`，再向 `dockerd` 发送 `SIGHUP` 热重载信号。辅助容器会在操作结束后删除，不需要映射宿主机 Docker 配置目录，也不会重启现有容器。

如果 Docker 使用了自定义配置文件路径，可在 `.env` 中设置 `HOST_DOCKER_CONFIG_PATH`。

## 本地开发

```bash
npm install
npm run dev
```

UI 使用 `http://localhost:3000`，API 使用 `http://localhost:3001`。本地没有设置 `ADMIN_PASSWORD` 时鉴权关闭；生产环境必须设置密码。

```bash
npm run typecheck
npm test
npm run build
```

## 权限说明

Docker Socket 等同于宿主机管理员权限。只在可信网络中使用，设置高强度密码，并通过 HTTPS 反向代理对外提供访问。镜像源应用功能会通过 Docker Socket 修改宿主机 Docker 配置并执行热重载。
