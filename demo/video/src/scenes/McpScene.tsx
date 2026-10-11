import React from "react";
import { AbsoluteFill } from "remotion";
import { Zoomable } from "../components/Zoomable";
import { KineticSubtitle } from "../components/KineticSubtitle";
import { ChapterBar } from "../components/ChapterBar";
import { SafeVideo } from "../components/SafeVideo";
import { SceneShell } from "../components/SceneShell";

/** MCP 能力：设置页 MCP 列表 zoom → 摸鱼电台点歌出声 */
export const McpScene: React.FC = () => (
  <SceneShell>
    <Zoomable
      keys={[
        { frame: 0, scale: 1.0, x: 960, y: 540 },
        { frame: 40, scale: 1.7, x: 640, y: 420 },
        { frame: 180, scale: 1.7, x: 640, y: 420 },
        { frame: 240, scale: 1.0, x: 960, y: 540 },
      ]}
    >
      <AbsoluteFill>
        <SafeVideo src="raw/mcp_2k.mp4" speed={3} startFrom={0} />
      </AbsoluteFill>
    </Zoomable>
    <ChapterBar index="03" title="MCP · 万物皆可接入" delay={40} />
    <KineticSubtitle lines={["放一首 周杰伦的晴天"]} startFrame={300} />
  </SceneShell>
);
