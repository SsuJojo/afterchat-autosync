# 自动化约定 / Automation conventions

本仓库的独立任务分支统一按下面的规则运行：

- 分支前缀：`feat/`、`fix/`、`chore/`、`refactor/`、`docs/`。
- 每次 push 由 `.github/workflows/auto-pr.yml` 自动构建、验收，并创建/刷新 **draft PR**（目标 `main`）。
- 未完成的独立分支 PR **必须保持 draft**；只有加上 `ready-for-review` 标签才可标记为 ready。工作流会把未打标签的 ready PR 转回 draft。
- PR 一开出来就自动审查并留言；验收失败会自动开 `bug` + `automation` issue（同分支同提交不重复）。
- PR 合并后自动删除源分支。
- Release 同时发布 `afterchat-autosync.user.js`（油猴版）和 `afterchat-autosync-extension-<version>.zip`（MV3 插件版）；两者由同一份 `tools/ac-sync.module.js` 构建，版本由 `version.json` 统一管理。

手动本地构建：

```bash
python -X utf8 tools/patch_afterchat.py --version-tag <release 后缀>
python -X utf8 tools/build_extension.py --sync-version
python -X utf8 tools/verify_autosync.py --base .
```
