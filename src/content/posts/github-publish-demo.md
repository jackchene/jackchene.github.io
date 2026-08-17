---
title: 从本地编辑到 GitHub 上线：完整流程演示
published: 2026-08-18
description: 用一篇真实演示文章走完新建、编辑、预览、发布、推送和线上查看。
image: ''
tags: [博客, GitHub, 教程]
category: 工程实践
draft: false
lang: ''
---

这是一篇完整的博客发布演示文章。

## 我是怎么写出来的

1. 在博客管理台点击“新建笔记”。
2. 点击这篇笔记的“编辑”，打开 Markdown 文件。
3. 在编辑器里填写标题、标签和正文。
4. 保存后，在本地预览页面检查排版。

## 这篇文章现在是什么状态

当前还是草稿，线上访客还看不到。下一步点击管理台里的“发布”，再确认推送到 GitHub。

## 线上发布后会发生什么

GitHub Actions 会自动安装依赖、构建 Astro 站点，并把 `dist` 发布到 GitHub Pages。

这篇文章用于验证从本地管理台到 GitHub Pages 的完整闭环。
