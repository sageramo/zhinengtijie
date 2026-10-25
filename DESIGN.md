---
name: "司序·知所先后"
description: "现有深青色中文任务工作台的源码视觉记录，非品牌定稿"
colors:
  accent: "#2f6f73"
  accent-deep: "#255b60"
  accent-soft: "#e6f1f1"
  bg: "#f6f8fb"
  panel: "#fff"
  panel-soft: "#f0f5f5"
  text: "#182c30"
  muted: "#52646b"
  line: "#dbe3e7"
  line-strong: "#abbcc2"
  warning: "#805422"
  warning-bg: "#fff8eb"
  danger: "#a2332d"
  danger-bg: "#fff3f1"
typography:
  headline:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "1.875rem"
    fontWeight: 650
    lineHeight: 1.3
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: 1.5
  task-title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  control:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "0.875rem"
    lineHeight: 1.5
  field:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "0.875rem"
    lineHeight: 1.65
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 550
rounded:
  field: "6px"
  button: "7px"
  message: "8px"
  surface: "12px"
spacing:
  compact: "8px"
  field-inset: "10px"
  small: "12px"
  control-inline: "14px"
  label-before: "16px"
  field-gap: "18px"
  medium: "20px"
  surface: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.panel}"
    typography: "{typography.control}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.accent-deep}"
    typography: "{typography.control}"
    rounded: "{rounded.button}"
    padding: "8px 6px"
  field:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.field}"
    rounded: "{rounded.field}"
    padding: "8px 10px"
  surface:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.surface}"
    padding: "24px"
---

# Design System: 司序·知所先后

## Overview

**Creative North Star: "逐件核对的工作台"**

沿用原页面的深青、白色主面与浅灰蓝背景，这是现有实现的视觉记录，不作为新品牌定稿；“司序”为主名，“知所先后”为辅名，名称下方以普通文字说明用途。学生在教室、宿舍和移动途中核对通知，需要明亮背景、可读的日期和清晰的表单，系统因此以紧凑操作层次、直白中文与原生控件为主。

本次合并保留既有文档的色彩、系统中文字体、边界分区与渐进展开决策，数值以 `agent.css` 为准，组件与状态以 `index.html`、`agent.js` 为准。操作顺序及首屏策略保存在 `.impeccable/surfaces/workbench.md`，不把这一页的双列构图当成所有页面的唯一模板。当前代理验收依据限于源码与非渲染 DOM；用户已自行打开本地工作台反馈“操作顺畅”，但自动浏览器访问仍被本机权限策略阻止，尚未独立核验实际桌面或手机几何、字体回退与渲染对比度。

**Key Characteristics:**

- 明亮青灰白与中性细边界，避免装饰渐变和大面积阴影。
- 中文操作层次、普通字号与日期数字优先，主名和辅名分级。
- 状态同时使用文字与颜色，证据、原文和配置通过原生展开项呈现。

## Colors

深青承担操作，青灰与白色承担信息容器，棕色和砖红承担需要处理的状态；下述名称对应前言中的原始 CSS 色值，既有变量格式保留。

### Primary

深青 `accent` 用于主按钮、键盘焦点和选择控件，深青暗部 `accent-deep` 用于链接、展开项与已确认文字，并作为主按钮悬停色；浅青 `accent-soft` 用于信息提示、文字按钮悬停和普通按钮按下。

### Neutral

浅灰蓝 `bg` 承托整页，白色 `panel` 承托工作区和输入框，浅青灰 `panel-soft` 用于普通按钮悬停。墨青 `text` 是正文，灰青 `muted` 是说明，浅灰 `line` 划分容器与条目，较深的 `line-strong` 保持输入控件和结果区域的边界可辨。

棕色 `warning` 与浅米色 `warning-bg` 用于待核对与警示，砖红 `danger` 与浅红 `danger-bg` 用于错误、冲突和缺口；它们是状态色，不是新增品牌副色。

**The Explicit State Rule.** 待核对、已确认、冲突、失效与保存失败均写出状态文字，颜色只加强已有文字，不独自承担结论。

## Typography

**Body Font:** 系统中文无衬线栈，以本机系统界面字体为首，中文回退为苹方与微软雅黑。当前是操作型工作台，没有独立展示字体；系统字体在此承担读写界面，不应据此扩展成营销页展示字体。

**Character:** 固定字号与有限字重形成稳定层次，不使用装饰大写、眉题或图形化文字。前言的 `headline` 对应页面主标题，`title` 对应分区，`task-title` 对应单件事项，`body` 对应正文，`control`、`field` 与 `label` 分别对应按钮、输入内容和字段标签。

主标题在手机断点缩为（1.625rem），品牌主名由（1.5rem）缩为（1.375rem），辅名由（1.125rem）缩为（1rem）。这是一套按角色指定的字阶，不是等比字号刻度；一般正文行高（1.65），分区说明与多行输入行高（1.7），表格日期与时长启用等宽数字。

**The Operable Text Rule.** 沿用既有正文至少（14px）、长文行高至少（1.6）的基线，操作保持普通字号，标题靠字重和层次区分。当前源码的（13px）辅助说明与（12px）页脚低于该阅读基线，本次仅记录差异，未把小字值纳入可继承的字号令牌，也未据此声称已通过可读性验收。

## Layout

空间主要由（8、12、16、18、20、24px）控制；字段的标签前距、双列横向间距与容器内边距按角色分配，不强行统一成单一倍数刻度。正文容器宽度上限（1368px），桌面左右内边距（24px）；阅读说明页宽度上限（880px），段落约束在（70ch）内。

当前工作台以输入与可编辑清单并列，桌面列宽为 `minmax(280px, .8fr) minmax(0, 1.7fr)`，列间距（28px），清单后续分区间距（24px）。在（1000px）以下，列宽改为 `minmax(270px, .85fr) minmax(0, 1.4fr)`，列间距与容器内边距缩为（20px）；在（760px）以下，改为单列，主面内边距为（20px 18px），字段与空闲表单单列，步骤和辅助导航换行。源码规定了这一响应式行为，但尚未完成真实视口验收。

长事项名称、来源和时间允许换行；列容器设最小宽度为零，窄屏容量表在自身区域横向滚动。原文、提取证据和配置使用原生 `details` 展开，核心字段仍位于页面内，来源不依赖弹窗承载。

## Elevation & Depth

当前样式没有 `box-shadow`；白色主面、浅灰蓝页面、单像素边框与条目分隔线共同区分信息层次。焦点是描边而非阴影，状态面以低强度底色提示；不为普通表面添加浮起效果。

**The Bounded Surface Rule.** 用中性边界、背景和间距组织操作区域；同一任务的字段属于同一展开项，不再把每个字段包成独立卡片。

## Shapes

主面采用柔和转角，输入框比按钮略紧，信息提示居中于两者与主面之间；各角色的圆角以 `rounded` 为准。按钮、输入与主面均有细边界，任务本身以顶部横线分隔，证据引用保留普通段落外观，没有装饰左侧色条、裁切角或胶囊标签体系。

## Components

### Buttons

主按钮深青底白字，普通按钮白底墨青字，文字按钮透明底深青字；共同内边距和圆角见前言。按钮桌面最小高度（42px），手机最小高度（44px），普通悬停改为浅青灰并强调边框，普通按下改为浅青；主按钮悬停变深青，文字按钮悬停变浅青。忙碌状态禁用按钮并替换为进行中的文字，普通禁用以（0.6）透明度与禁止指针表示。

所有键盘可聚焦元素使用深青描边（3px），外偏移（3px）。按钮只对背景与边框作（160ms ease）过渡，减少动态效果时关闭此过渡；CSS 同时关闭默认平滑滚动，JavaScript 的三处滚动调用也读取同一减少动态偏好，在 `reduce` 时改用立即滚动。这一行为已核对源码，尚未进行真实播放器或浏览器动态效果验收。

### Inputs / Fields

标签放在控件上方，默认白底、较深中性描边、最小高度（42px），横向撑满所在列；日期、时间和选择使用原生输入。多行输入允许纵向缩放，最小高度（120px）。占位与说明使用灰青，禁用字段改用浅灰蓝底；无效输入保留用户输入、以砖红边框和相邻文字说明问题。

### Navigation

页头将主名和辅名置于左侧，将计算说明与独立旧版对话置于右侧；辅助链接是普通文字，不伪装为主要操作。页内步骤是带数字的锚点链接，桌面横向排列，窄屏换行；链接悬停转为正文色，键盘焦点沿用公共描边，页首有键盘可见的跳转清单入口。旧版 Dify 入口独立运行，与当前清单的关系由可访问文字和配置区说明交代。

### Cards / Containers

白色主面负责分区，内部先放标题与简短说明，再放操作内容；平面边界沿用 Elevation & Depth。任务条目以横线开始，标题、明确状态与类型位于上部，字段、条件和证据使用原生展开项；未核对事项默认展开，减少回找关键字段的成本。这里不建立独立的图标、标签或装饰卡片体系。

### State and Results

全局提示与保存状态通过 `role="status"` 或礼貌播报区呈现，局部字段错误靠近所属字段，加载文案保留当前动作。空清单解释下一步并提供导入或手动入口，虚构示例由用户主动填入。结果以文字结论、累计容量表和可展开依据组织，缺口用明确“缺少”文字表达；修改事项或时间后清除旧结果并提示重新检查。表格把必要容量条件与具体排程能力分开说明，不将剩余容量包装成确定可行的日程承诺。

## Do's and Don'ts

### Do:

- **Do** 保留深青操作、青灰白信息面与中性边界，状态同时写明文字。
- **Do** 保留中文正文的阅读基线、主辅名层次、可见键盘焦点与原生表单语义。
- **Do** 在相邻说明中明确输入依据、未验证部分与当前状态，核心字段留在页面内。

### Don't:

- **Don't** 为操作型工作台添加装饰渐变、大面积阴影、眉题或无依据的图形装饰。
- **Don't** 将现有较小辅助字、局部特殊值或尚未视觉验收的几何当成未来页面的强制模板。
- **Don't** 把本次源码记录称为品牌定稿、桌面手机视觉验收通过或完整排程能力证明。
