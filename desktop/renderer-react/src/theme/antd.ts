/**
 * Ant Design 的主题层:把 styles.css 里的 macOS token(系统色、字号层级、圆角、控件高度、焦点环、材质)
 * 映射到 AntD 的 token 与各组件的 component token。深浅色 / 实底 / 材质切换后重算一次,两套界面永远取同一份值。
 *
 * 几条按 HIG 定的规矩,都落在这里而不是散在各页:
 *   · 颜色只落在圆点、图标、开关、主按钮上;面(卡片、列表、提示条)是中性的,警告面只有 8–10% 的淡染;
 *   · 弹层(菜单、提示、通知)是浮起来的实底面 + 发丝边 + 柔和阴影,不是网页那种硬阴影;
 *   · 点击不出水波纹(wave 在 ConfigProvider 里整个关掉),动效 100–200ms;
 *   · 主题走 CSS 变量模式(cssVar):切深浅色只改变量,不重注入样式表。
 */
import { useMemo } from 'react';
import { theme, type ThemeConfig } from 'antd';
import { useDark } from './appearance';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 强调色的淡染:选中行、警告面、焦点环都用它,深浅色下同一比例。 */
const mix = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function buildAntdTheme(dark: boolean): ThemeConfig {
  const blue = cssVar('--blue', dark ? '#0a84ff' : '#007aff');
  const green = cssVar('--green', dark ? '#32d74b' : '#28cd41');
  const orange = cssVar('--orange', dark ? '#ff9f0a' : '#ff9500');
  const red = cssVar('--red', dark ? '#ff453a' : '#ff3b30');
  const label = cssVar('--label', dark ? '#ffffff' : '#000000');
  const label2 = cssVar('--label-secondary', 'rgba(60,60,67,0.6)');
  const label3 = cssVar('--label-tertiary', 'rgba(60,60,67,0.3)');
  const separator = cssVar('--separator', 'rgba(60,60,67,0.18)');
  const fill = cssVar('--bg-fill', 'rgba(120,120,128,0.12)');
  const fillStrong = cssVar('--bg-fill-strong', 'rgba(120,120,128,0.2)');
  const bgControl = cssVar('--bg-control', '#ffffff');
  const bgElevated = cssVar('--bg-elevated', '#ffffff');
  const bgContent = cssVar('--bg-content', '#fbfbfd');
  const shadowCard = cssVar('--shadow-card', '0 1px 3px rgba(0,0,0,0.06)');
  const shadowControl = cssVar('--shadow-control', '0 0.5px 1px rgba(0,0,0,0.1)');
  const font = cssVar('--font', '-apple-system, "Segoe UI", sans-serif');
  const mono = cssVar('--font-mono', 'ui-monospace, Menlo, monospace');
  // 弹层阴影:macOS 的菜单 / 弹出面板是一圈 0.5px 的边 + 大而软的投影
  const shadowPopup = dark
    ? '0 0 0 0.5px rgba(255,255,255,0.14), 0 10px 32px rgba(0,0,0,0.55)'
    : '0 0 0 0.5px rgba(0,0,0,0.12), 0 10px 32px rgba(0,0,0,0.16)';
  const focusRing = `0 0 0 3.5px ${mix(blue, 30)}`;
  // 弹层与通知要是实底:半透明面板叠在正文上会把字透出来
  const bgPopup = cssVar('--bg-popup', dark ? '#2a2a2e' : '#ffffff');

  return {
    cssVar: { key: 'dafri' },
    hashed: false,
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: blue,
      colorInfo: blue,
      colorSuccess: green,
      colorWarning: orange,
      colorError: red,
      colorLink: blue,
      colorText: label,
      colorTextHeading: label,
      colorTextSecondary: label2,
      colorTextTertiary: label3,
      colorTextQuaternary: label3,
      colorTextPlaceholder: label3,
      colorTextDescription: label2,
      colorTextLabel: label2,
      colorIcon: label2,
      colorIconHover: label,
      colorBgContainer: bgControl,
      colorBgElevated: bgPopup,
      colorBgLayout: bgContent,
      colorBgSpotlight: dark ? '#3a3a3e' : '#3a3a3c',
      colorBgMask: 'rgba(0, 0, 0, 0.32)',
      colorBorder: separator,
      colorBorderSecondary: separator,
      colorSplit: separator,
      colorFill: fillStrong,
      colorFillSecondary: fill,
      colorFillTertiary: fill,
      colorFillQuaternary: 'rgba(120, 120, 128, 0.08)',
      fontFamily: font,
      fontFamilyCode: mono,
      fontSize: 13,
      fontSizeSM: 11,
      fontSizeLG: 15,
      fontSizeXL: 20,
      fontSizeHeading1: 20,
      fontSizeHeading2: 15,
      fontSizeHeading3: 13,
      fontSizeHeading4: 12,
      fontSizeHeading5: 11,
      fontWeightStrong: 590,
      lineHeight: 1.47,
      // 圆角同心:卡片 20 → 控件 12 → 小控件 9;控件比 macOS 那版高一档
      borderRadius: 12,
      borderRadiusSM: 9,
      borderRadiusLG: 20,
      borderRadiusXS: 6,
      controlHeight: 32,
      controlHeightSM: 24,
      controlHeightLG: 40,
      lineWidth: 1,
      // AppKit 的 focus ring:3.5px、强调色 30%,和 styles.css 的 --focus-ring 一致
      controlOutlineWidth: 3.5,
      controlOutline: mix(blue, 30),
      controlItemBgHover: fill,
      controlItemBgActive: mix(blue, 12),
      controlItemBgActiveHover: mix(blue, 16),
      boxShadow: shadowCard,
      boxShadowSecondary: shadowPopup,
      boxShadowTertiary: shadowControl,
      motionDurationFast: '0.1s',
      motionDurationMid: '0.15s',
      motionDurationSlow: '0.2s',
      wireframe: false,
    },
    components: {
      Button: {
        defaultBg: bgControl,
        defaultBorderColor: separator,
        defaultShadow: shadowControl,
        defaultHoverBg: fillStrong,
        defaultHoverBorderColor: separator,
        defaultActiveBg: fillStrong,
        defaultActiveBorderColor: separator,
        primaryShadow: 'none',
        dangerShadow: 'none',
        contentFontSize: 13,
        contentFontSizeSM: 12,
        paddingInline: 14,
        paddingInlineSM: 10,
        fontWeight: 510,
        borderRadius: 999,
        borderRadiusSM: 999,
        borderRadiusLG: 999,
        // 纯文字按钮是强调色的"可点的词"(Mail 的「清空」、Finder 的「显示」),不是灰字
        textTextColor: blue,
        textTextHoverColor: blue,
        textTextActiveColor: blue,
        textHoverBg: fill,
        linkHoverBg: fill,
      },
      Switch: {
        colorPrimary: green,
        colorPrimaryHover: green,
        trackHeight: 26,
        trackMinWidth: 46,
        handleSize: 22,
        trackPadding: 2,
      },
      Segmented: {
        trackBg: fill,
        trackPadding: 2,
        itemColor: label,
        itemHoverColor: label,
        itemHoverBg: fill,
        itemSelectedBg: bgControl,
        itemSelectedColor: label,
        itemActiveBg: fill,
        borderRadius: 999,
        borderRadiusSM: 999,
        borderRadiusLG: 999,
        borderRadiusXS: 999,
        controlHeight: 30,
        controlHeightSM: 26,
        fontSize: 12,
        fontSizeLG: 13,
        boxShadowTertiary: shadowControl,
      },
      Menu: {
        // 源列表侧栏:透明底、28px 行高、10px 内缩、选中项强调色填充,与 Finder / Notes 一致
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemColor: label,
        itemHoverBg: fill,
        itemHoverColor: label,
        itemActiveBg: fillStrong,
        itemSelectedBg: bgControl,
        itemSelectedColor: label,
        itemHeight: 38,
        itemMarginInline: 10,
        itemMarginBlock: 2,
        itemPaddingInline: 8,
        itemBorderRadius: 12,
        subMenuItemBorderRadius: 12,
        iconSize: 24,
        iconMarginInlineEnd: 10,
        collapsedWidth: 60,
        collapsedIconSize: 24,
        activeBarBorderWidth: 0,
        groupTitleColor: label3,
        groupTitleFontSize: 11,
        fontSize: 13,
      },
      Card: {
        colorBgContainer: bgElevated,
        colorBorderSecondary: separator,
        borderRadiusLG: 20,
        bodyPadding: 16,
        bodyPaddingSM: 12,
        headerPadding: 12,
        headerPaddingSM: 12,
        headerFontSize: 13,
        headerFontSizeSM: 13,
        headerHeight: 40,
        headerHeightSM: 34,
        extraColor: label2,
        actionsBg: 'transparent',
      },
      List: {
        // System Settings 那种内嵌分组列表:发丝分隔、10px 圆角、行内 9×12 内边距
        itemPadding: '9px 12px',
        itemPaddingSM: '8px 12px',
        itemPaddingLG: '12px 14px',
        colorBorder: separator,
        colorSplit: separator,
        borderRadiusLG: 20,
        descriptionFontSize: 11,
        metaMarginBottom: 0,
        emptyTextPadding: 14,
      },
      Alert: {
        // 提示条:说明类是中性的面,警告 / 错误 / 成功只淡淡染一层,颜色主要落在图标上
        colorInfoBg: bgElevated,
        colorInfoBorder: separator,
        colorInfo: blue,
        colorWarningBg: mix(orange, 10),
        colorWarningBorder: mix(orange, 35),
        colorErrorBg: mix(red, 10),
        colorErrorBorder: mix(red, 35),
        colorSuccessBg: mix(green, 10),
        colorSuccessBorder: mix(green, 35),
        defaultPadding: '9px 12px',
        withDescriptionPadding: '10px 12px',
        withDescriptionIconSize: 16,
        fontSize: 12,
        fontSizeLG: 13,
        borderRadiusLG: 16,
        lineHeight: 1.55,
      },
      Collapse: {
        headerBg: 'transparent',
        headerPadding: '4px 0',
        contentPadding: '0',
        contentBg: 'transparent',
        fontSize: 12,
        colorTextHeading: label2,
        borderRadiusLG: 6,
      },
      Steps: {
        iconSize: 18,
        iconFontSize: 11,
        customIconSize: 18,
        customIconFontSize: 18,
        titleLineHeight: 20,
        descriptionMaxWidth: 720,
        colorTextDescription: label2,
        fontSize: 13,
        fontSizeSM: 11.5,
        iconSizeSM: 18,
        dotSize: 6,
        dotCurrentSize: 8,
      },
      Statistic: {
        titleFontSize: 10.5,
        contentFontSize: 14,
        colorTextDescription: label2,
        fontFamily: font,
      },
      Progress: {
        defaultColor: label3,
        remainingColor: fillStrong,
        lineBorderRadius: 4,
      },
      Badge: {
        statusSize: 8,
        textFontSize: 12,
        textFontSizeSM: 10.5,
        indicatorHeight: 18,
        indicatorHeightSM: 16,
        dotSize: 6,
        colorError: red,
      },
      Table: {
        headerBg: 'transparent',
        headerColor: label2,
        headerSplitColor: 'transparent',
        headerBorderRadius: 0,
        rowHoverBg: fill,
        rowSelectedBg: mix(blue, 10),
        rowSelectedHoverBg: mix(blue, 16),
        borderColor: separator,
        cellPaddingBlockSM: 5,
        cellPaddingInlineSM: 8,
        cellFontSizeSM: 12,
        headerSortActiveBg: 'transparent',
        headerSortHoverBg: 'transparent',
        bodySortBg: 'transparent',
        footerBg: 'transparent',
      },
      Input: { activeShadow: focusRing, colorBgContainer: bgControl, hoverBorderColor: separator },
      InputNumber: { activeShadow: focusRing, colorBgContainer: bgControl, hoverBorderColor: separator, handleBg: bgControl },
      Select: { optionSelectedBg: mix(blue, 12), optionSelectedFontWeight: 510, selectorBg: bgControl, hoverBorderColor: separator, activeOutlineColor: mix(blue, 30) },
      Descriptions: { labelBg: 'transparent', itemPaddingBottom: 4, titleMarginBottom: 8 },
      Tooltip: { colorBgSpotlight: dark ? '#3a3a3e' : '#3a3a3c', fontSize: 11, borderRadius: 6 },
      Popover: { fontSize: 12, titleMinWidth: 120 },
      Modal: { titleFontSize: 13, contentBg: bgPopup, headerBg: bgPopup, footerBg: bgPopup },
      Notification: {
        width: 400,
        colorBgElevated: bgPopup,
        borderRadiusLG: 22,
        fontSizeLG: 13,
        colorIcon: label2,
        colorIconHover: label,
      },
      Message: { contentBg: bgPopup, contentPadding: '8px 14px' },
      Tag: { defaultBg: fill, defaultColor: label2, borderRadiusSM: 999 },
      Empty: { colorTextDescription: label3, fontSize: 12 },
      Timeline: { dotBg: bgElevated, tailColor: separator, itemPaddingBottom: 8 },
      Splitter: {
        splitBarSize: 1,
        splitTriggerSize: 6,
        colorFill: separator,
        controlItemBgHover: fillStrong,
        controlItemBgActive: blue,
        controlItemBgActiveHover: blue,
      },
      Skeleton: { gradientFromColor: fill, gradientToColor: fillStrong },
      Spin: { dotSize: 20, dotSizeSM: 14 },
      Typography: { titleMarginBottom: 0, titleMarginTop: 0 },
      Divider: { colorSplit: separator, textPaddingInline: 8 },
    },
  };
}

export function useAntdTheme(): ThemeConfig {
  const dark = useDark();
  return useMemo(() => buildAntdTheme(dark), [dark]);
}
