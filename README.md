# dsh-solmirror

[![npm version](https://img.shields.io/npm/v/dsh-solmirror.svg)](https://www.npmjs.com/package/dsh-solmirror)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

把[瞬镜开放平台](https://aigc.solmirror.cn)（Solmirror）的图片、视频生成能力接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）：智能体直接用提示词生成图片和视频，结果在对话内播放、展示，按平台价格计积分，失败自动退款。

> Bring Solmirror's image & video generation models into dsh as MCP tools — with reference uploads, cost estimates, background-tracked video jobs and in-chat playback.

## 功能特性

- **7 个 MCP 工具**：模型目录（`list_models`）、估价（`estimate_cost`）、参考素材上传（`upload_reference`）、文生图/图生图（`generate_image`）、文生视频/图生视频/参考视频·参考音色（`generate_video`）、结果查询（`get_generation`）、媒体地址（`get_media_url`）
- **视频生成走 dsh 原生后台任务**：提交即返，完成/失败自动通知，agent 无需轮询
- **对话内媒体面**：生成中显示跟随比例的进度占位，视频内嵌播放器、图片出图墙，历史会话回看同样有效
- **设置页配置**：API 密钥、服务器地址、可见模型组、测试连接；密钥只存本机 dsh 凭据存储，不回显明文
- **参考素材可复用**：本地图片/视频/音频上传一次得到素材标识，多次生成直接引用

## 安装

**方式一：npm（推荐，可在 dsh 插件页一键更新）**

```sh
dsh plugin --profile <你的profile> add dsh-solmirror
```

或在 dsh 网页 → 侧栏「插件」→ 添加插件，输入 `dsh-solmirror`。

**方式二：从源码安装**

```sh
dsh plugin --profile <你的profile> add github:cthulhu-tww/dsh-solmirror
```

## 配置

打开 dsh 网页 → 左下角 **设置 → 瞬镜开放平台**：

| 配置项 | 说明 |
|---|---|
| API 密钥 | 在瞬镜「开放平台 → API 密钥」创建的 `sk-…`，粘贴保存。只存在本机，不回显明文 |
| 服务器地址 | `https://aigcserver.solmirror.cn/mcp`（也可从瞬镜平台「插件接入」页一键复制） |
| 可见模型组 | 勾选后智能体只能看到并使用这些模型组；不勾 = 全部可见 |
| 测试连接 | 用当前密钥和地址向瞬镜服务发起一次验证，即时反馈是否可用 |

保存即生效，无需重启 dsh（新配置几秒内自动应用）；想立即确认，点「测试连接」。

## 工具一览

| 工具 | 说明 |
|---|---|
| `list_models` | 查看可用的图片/视频模型与能力（按「可见模型组」过滤） |
| `estimate_cost` | 生成前估价：按参数算出本次要扣多少积分，只询价、不生成、不扣费 |
| `generate_image` | 文生图/图生图，支持参考图 |
| `generate_video` | 文生视频/图生视频/参考视频生成；部分模型支持参考音色——上传音频作为素材后，在台词处标注（参考音频1），对应角色会用该音色说话 |
| `upload_reference` | 上传本地参考素材（图片/视频/音频），返回素材标识，生成时引用。同一素材可重复使用：没用过的保留 1 天、用过的自最后一次使用保留 3 天，过期重新上传即可。支持 jpg/png/webp/gif、mp4/mov/webm（≤30 秒）、mp3/wav（≤60 秒），单文件 ≤50MB，不合规会当场报错 |
| `get_generation` | 查询生成结果 |
| `get_media_url` | 获取产物的临时查看/下载地址 |

## 积分说明

生成按平台实时计价扣积分，与站内同价：个人密钥扣个人积分，企业密钥扣企业积分池；生成失败或审核不通过自动退款。生成前可用 `estimate_cost` 询价。历史生成记录可在瞬镜平台「开放平台 → 生成记录」查看。

## 许可证

[MIT](LICENSE)
