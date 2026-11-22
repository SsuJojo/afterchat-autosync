# AfterChat AutoSync Console（扩展骨架）

## 安装

1. 在仓库根目录生成页面脚本（尚未包含在仓库里）：

   ```bash
   python -X utf8 tools/patch_afterchat.py --version-tag ac6
   python -X utf8 tools/build_extension.py --sync-version
   ```

   第一条从 `vendor/afterchat.user.js` + `tools/ac-sync.module.js` 生成 `dist/afterchat-autosync.user.js`（`--version-tag` 取 `version.json` 的 `release` 后缀）；第二条把它复制成 `extension/patched.user.js`，并把 `manifest.json` 版本同步到 `version.json`。manifest 已引用它。

2. 打开 `edge://extensions`（Edge）或 `chrome://extensions`（Chrome）。
3. 开启右上角 **开发人员模式**。
4. 点击 **加载解压缩的扩展**，选择本仓库的 `extension/` 目录。

## 使用

1. 点击工具栏的 AfterChat AutoSync 图标，打开控制台弹窗。
2. 点击 **选择/更换目录**，在文件选择器中选定同步根目录（需要读写权限）。
3. 目录名会显示在弹窗顶部；**最近聊天** 与 **平台状态** 每 15 秒自动刷新；点击任意聊天行查看对话正文（前 200 行）。
4. **刷新所有已打开的聊天标签页**，让页面脚本通过新的桥接读取同一个目录。

目录句柄保存在扩展自己的 IndexedDB（`acSyncExtDb` / `handles` / `root`），所有 29 个站点共用一次选择，无需在每个网站重复授权。

> 注意：本目录只含扩展骨架；`patched.user.js` 由构建脚本生成，请勿手工编辑。
