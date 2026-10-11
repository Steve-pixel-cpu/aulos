import React from "react";
import { AbsoluteFill } from "remotion";
import { Zoomable } from "../components/Zoomable";
import { KineticSubtitle } from "../components/KineticSubtitle";
import { ChapterBar } from "../components/ChapterBar";
import { SafeVideo } from "../components/SafeVideo";
import { SceneShell } from "../components/SceneShell";

/** 干活① 命令行无头跑任务：6× 快放 + 三处 zoom 推近 + 结果段放慢 */
export const CliScene: React.FC = () => (
  <SceneShell>
    <Zoomable
      keys={[
        { frame: 0, scale: 1.0, x: 960, y: 540 },
        { frame: 60, scale: 1.6, x: 1180, y: 620 },
        { frame: 240, scale: 1.6, x: 1180, y: 620 },
        { frame: 300, scale: 1.15, x: 960, y: 540 },
        { frame: 700, scale: 1.7, x: 700, y: 480 },
        { frame: 760, scale: 1.0, x: 960, y: 540 },
      ]}
    >
      <AbsoluteFill>
        <SafeVideo src="raw/cli_2k.mp4" speed={6} startFrom={0} />
      </AbsoluteFill>
    </Zoomable>
    <ChapterBar index="01" title="命令行 · 无头跑任务" delay={40} />
    <KineticSubtitle lines={["一条命令 交给 aulos"]} startFrame={120} />
  </SceneShell>
);
