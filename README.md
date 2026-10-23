# 拼图推进

一幅拼图 = 一个目标，一块 = 一个有证据的产出。随手记一句话挂到块上，拼上一块就写一张经验卡（做 → 卡 → 讲 → 送），每周日 20 分钟回顾。

手机主屏打开，断网也能记，联网后手机和电脑自动同步。

地址：<https://daxuecmd.github.io/puzzle-progress/>

## 在手机上安装（一加 / 安卓）

1. 用 **Edge** 或 **Chrome** 打开上面的地址
2. 点右下角「…」菜单 →「添加到手机」或「安装应用」
3. 主屏上会出现蓝色拼图图标「拼图推进」，以后从这里打开

## 开同步（手机和电脑各做一次）

1. 打开 App →首页右上角 ⚙ 设置 →「怎么拿令牌」→「打开 GitHub 建令牌页」
2. 「Repository access」选 **Only select repositories**，再选 **puzzle-progress-data**
3. 拉到底点 **Generate token**，复制 `github_pat_` 开头的那串字
4. 粘到设置里的「令牌」，点「保存并测试」

令牌只存在这台设备上，只能读写这一个私有仓库。丢了手机就到 GitHub 的令牌页把它删掉，再建一个新的。

## 备份

设置 →「导出全部数据」，得到一个文件（含图片和录音，不含令牌）。换手机时「导入备份」。

## 开发

原生 HTML / CSS / JS，没有构建步骤、没有 npm 包。

```
本地预览：node tests/serve.mjs          → http://127.0.0.1:8791/
数据层自测：node tests/check.mjs
浏览器自测：node tests/browser-check.mjs  （本机 Edge 无头模式）
```

规则见 `docs/method.md`，界面规范见 `docs/design.md`。
