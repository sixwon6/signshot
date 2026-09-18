/**
 * PhotoFrame: the paper print. Paper carries graphite only, never teal, so the teal copy readout
 * ("002 / 010 · YOUR COPY") sits below the paper and is the caller's to render.
 */
import React from "react";
import {
  Image,
  PixelRatio,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, radius } from "../theme";
import { fonts } from "../fonts";

interface PhotoFrameProps {
  /** The photograph. Omit and pass `children` to place a placeholder or a live preview. */
  source?: ImageSourcePropType;
  children?: React.ReactNode;
  /** Imprinted on the paper. Present means a caption band; absent means a plain foot. */
  title?: string;
  /** Imprinted under the title, e.g. "BY SEEK3R.SKR". */
  byline?: string;
  /** Right of the caption band. Defaults to the app's own imprint. */
  mark?: string;
  /** Grid prints use the tighter 8 px border; full prints use 10 px. */
  variant?: "full" | "grid";
  /**
   * An explicit picture height: the picture still spans the paper's width and the photograph
   * is cover-cropped into that band. Ignored when `aspectRatio` is given. The publish and send
   * sheets use it for their strip; a print that shows a whole photograph passes `aspectRatio`.
   */
  imageHeight?: number;
  /**
   * The photograph's own width ÷ height. The paper follows the picture — portrait, landscape or
   * square — with the same border on every side. Omitted, or with `imageHeight` given, the
   * print falls back to a square.
   */
  aspectRatio?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function PhotoFrame({
  source,
  children,
  title,
  byline,
  mark = "SIGNSHOT",
  variant = "full",
  imageHeight,
  aspectRatio,
  style,
  testID,
}: PhotoFrameProps) {
  const captioned = Boolean(title || byline);
  const grid = variant === "grid";
  /** The caption row's width once laid out; until then (0) the mark is drawn. */
  const [captionWidth, setCaptionWidth] = React.useState(0);
  const imprint = grid ? GRID_IMPRINT : FULL_IMPRINT;
  /**
   * The date never truncates: both halves are monospace, so their widths come from character
   * counts, and when they do not fit the right-hand mark is dropped instead.
   */
  const showMark =
    Boolean(mark) &&
    (captionWidth === 0 ||
      monoWidth(byline ?? "", imprint.size, imprint.byline) +
        CAPTION_GAP +
        monoWidth(mark, imprint.size, imprint.mark) <=
        captionWidth);
  // A captioned print takes the full-print border of 10 px; an uncaptioned grid print takes
  // the tighter 8 px one.
  const pad = captioned || !grid ? FULL_PAD : GRID_PAD;
  const foot = captioned ? 0 : FOOT;

  return (
    <View
      testID={testID}
      style={[
        styles.paper,
        { paddingTop: pad, paddingLeft: pad, paddingRight: pad, paddingBottom: foot },
        style,
      ]}
    >
      {/* Never a ratio and a height together: Yoga would derive the width from the height and
          pin a square to the paper's left edge. */}
      <View
        style={[
          styles.picture,
          aspectRatio != null && aspectRatio > 0
            ? { aspectRatio }
            : imageHeight != null
              ? { height: imageHeight }
              : styles.square,
        ]}
      >
        {source ? (
          <Image source={source} resizeMode="cover" style={styles.fill} />
        ) : (
          children
        )}
      </View>

      {captioned ? (
        <View
          style={styles.caption}
          onLayout={(event) => setCaptionWidth(event.nativeEvent.layout.width)}
        >
          <View style={styles.captionText}>
            {title ? (
              // Two lines at the grid's smaller imprint, one at full size: a title long enough
              // to need them is imprinted whole rather than cut to "Seaside Af…".
              <Text
                numberOfLines={grid ? 2 : 1}
                style={[styles.title, grid && styles.titleGrid]}
              >
                {title}
              </Text>
            ) : null}
            {byline ? (
              <Text numberOfLines={1} style={[styles.byline, { fontSize: imprint.size, letterSpacing: imprint.byline }]}>
                {byline}
              </Text>
            ) : null}
          </View>
          {showMark ? (
            <Text
              numberOfLines={1}
              style={[styles.mark, { fontSize: imprint.size, letterSpacing: imprint.mark }]}
            >
              {mark}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The imprint row's two sizes: 9 on a full print, smaller on a grid one. */
const FULL_IMPRINT = { size: 9, byline: 1.44, mark: 1.62 };
const GRID_IMPRINT = { size: 8, byline: 1.28, mark: 1.44 };
const CAPTION_GAP = 10;
/** Paper border: 10 px on a full print, 8 px on a grid one, with a 26 px foot when uncaptioned. */
const FULL_PAD = 10;
const GRID_PAD = 8;
const FOOT = 26;
/**
 * IBM Plex Mono advances every glyph by 0.6 em, so a mono string's width is its length times the
 * size times 0.6, plus one letter-space per character — and times the phone's text scale, which
 * grows the glyphs but not the paper. No text measurement, and therefore no layout pass, needed.
 */
function monoWidth(text: string, size: number, tracking: number) {
  const scale =
    typeof PixelRatio?.getFontScale === "function" ? PixelRatio.getFontScale() : 1;
  return text.length * (size * 0.6 * scale + tracking);
}

const styles = StyleSheet.create({
  paper: {
    backgroundColor: colors.paper,
    borderRadius: radius.print,
    shadowColor: "#000000",
    shadowOpacity: 0.58,
    shadowOffset: { width: 0, height: 14 },
    shadowRadius: 34,
    elevation: 8,
  },
  picture: { width: "100%", overflow: "hidden" },
  square: { aspectRatio: 1 },
  fill: { width: "100%", height: "100%" },
  caption: {
    paddingTop: 12,
    paddingBottom: 14,
    paddingHorizontal: 2,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: CAPTION_GAP,
  },
  captionText: { flexShrink: 1, minWidth: 0, gap: 3 },
  title: {
    fontFamily: fonts.display,
    fontSize: 16,
    lineHeight: 18,
    color: colors.graphite,
  },
  /** Smaller, and free to take a second line, so a grid title is imprinted whole. */
  titleGrid: { fontSize: 13, lineHeight: 15 },
  byline: {
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    color: "rgba(32,37,30,0.62)",
  },
  mark: {
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    color: "rgba(32,37,30,0.62)",
  },
});
