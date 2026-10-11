/** Paper print. Paper never carries teal, so the copy readout is the caller's, below the paper. */
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
  /** Omit and pass `children` for a placeholder or live preview. */
  source?: ImageSourcePropType;
  children?: React.ReactNode;
  /** Presence switches the plain foot to a caption band. */
  title?: string;
  byline?: string;
  mark?: string;
  variant?: "full" | "grid";
  /** Cover-crops into a full-width band of this height. Ignored when `aspectRatio` is given. */
  imageHeight?: number;
  /** Width ÷ height. Falls back to square when omitted and no `imageHeight`. */
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
  /** 0 until laid out; the mark shows until then. */
  const [captionWidth, setCaptionWidth] = React.useState(0);
  const imprint = grid ? GRID_IMPRINT : FULL_IMPRINT;
  /** The byline never truncates; when byline and mark don't fit, drop the mark. */
  const showMark =
    Boolean(mark) &&
    (captionWidth === 0 ||
      monoWidth(byline ?? "", imprint.size, imprint.byline) +
        CAPTION_GAP +
        monoWidth(mark, imprint.size, imprint.mark) <=
        captionWidth);
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

const FULL_IMPRINT = { size: 9, byline: 1.44, mark: 1.62 };
const GRID_IMPRINT = { size: 8, byline: 1.28, mark: 1.44 };
const CAPTION_GAP = 10;
const FULL_PAD = 10;
const GRID_PAD = 8;
const FOOT = 26;
/** IBM Plex Mono advances 0.6 em per glyph, so width is computable without a layout pass. */
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
