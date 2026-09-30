"use client";

import { Separator } from "@/components/ui/separator";
import {
	type Tab,
	useAssetsPanelStore,
} from "@/components/editor/panels/assets/assets-panel-store";
import { TabBar } from "./tabbar";
import { Captions } from "@/subtitles/components/assets-view";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { SoundsView } from "@/sounds/components/assets-view";
import { StickersView } from "@/stickers/components/assets-view";
import { TextView } from "@/text/components/assets-view";
import { EffectsView } from "@/effects/components/assets-view";
import { TransitionsView } from "@/motion/assets-view";
import { BrandKitView } from "@/graphics/brand-kit-view";
import { useEditor } from "@/editor/use-editor";
import { getMotionIssues } from "@/motion";

export function AssetsPanel() {
	const { activeTab, setActiveTab } = useAssetsPanelStore();
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const issueCount = getMotionIssues(tracks).length;

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		sounds: <SoundsView />,
		text: <TextView />,
		stickers: <StickersView />,
		effects: <EffectsView key="effects" />,
		transitions: <TransitionsView />,
		brand: <BrandKitView />,
		captions: <Captions />,
		adjustment: <EffectsView key="adjustments" initialSearch="color" title="Adjustments" />,
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex flex-1 flex-col overflow-hidden">
				{issueCount > 0 && (
					<button
						type="button"
						onClick={() => setActiveTab("transitions")}
						className="shrink-0 bg-amber-950 p-2 text-xs text-amber-200"
					>
						{issueCount} transition(s) need attention — review before export
					</button>
				)}
				<div className="min-h-0 flex-1">{viewMap[activeTab]}</div>
			</div>
		</div>
	);
}
