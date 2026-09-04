"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
	selectExportDestination,
} from "@/export";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	type ExportBitrateMode,
	type ExportDestinationSelection,
	type ExportEncoder,
	type ExportFormat,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import { toast } from "sonner";
import {
	DEFAULT_EXPORT_QUALITY_SLIDER,
	EXPORT_RESOLUTION_PRESETS,
	estimateExportSizeRangeBytes,
	formatExportDuration,
	formatExportSize,
	getExportVideoBitrate,
	resolveExportDimensions,
	type ExportResolutionPreset,
} from "@/export/settings";
import { floatToFrameRate, frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND } from "@/wasm";
import { getNativeMediaHealth } from "@/services/native-media/client";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isResolutionPreset(value: string): value is ExportResolutionPreset {
	return EXPORT_RESOLUTION_PRESETS.some((preset) => preset === value);
}

function isExportEncoder(value: string): value is ExportEncoder {
	return ["auto", "native_nvenc", "webcodecs"].includes(value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const {
		isExporting,
		progress,
		result: exportResult,
		totalFrames,
		currentFrame,
		elapsedMs,
	} = exportState;
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [resolutionPreset, setResolutionPreset] =
		useState<ExportResolutionPreset>("project");
	const [fpsSelection, setFpsSelection] = useState("project");
	const [qualityValue, setQualityValue] = useState(
		DEFAULT_EXPORT_QUALITY_SLIDER,
	);
	const [bitrateMode, setBitrateMode] = useState<ExportBitrateMode>("variable");
	const [encoder, setEncoder] = useState<ExportEncoder>("auto");
	const [nativeNvencAvailable, setNativeNvencAvailable] = useState(false);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const projectFps = frameRateToFloat(activeProject.settings.fps);
	const outputFps =
		fpsSelection === "project" ? projectFps : Number(fpsSelection);
	const outputDimensions = useMemo(
		() =>
			resolveExportDimensions({
				projectWidth: activeProject.settings.canvasSize.width,
				projectHeight: activeProject.settings.canvasSize.height,
				preset: resolutionPreset,
			}),
		[activeProject.settings.canvasSize, resolutionPreset],
	);
	const videoBitrate = getExportVideoBitrate({
		...outputDimensions,
		fps: outputFps,
		quality: qualityValue,
		format,
	});
	const durationSeconds = editor.timeline.getTotalDuration() / TICKS_PER_SECOND;
	const estimatedSize = estimateExportSizeRangeBytes({
		durationSeconds,
		videoBitrate,
		includeAudio: shouldIncludeAudio,
		bitrateMode,
	});
	const etaMs =
		elapsedMs && progress > 0 && progress < 1
			? (elapsedMs * (1 - progress)) / progress
			: null;
	const fpsOptions = [...new Set([projectFps, 60, 30, 24])];

	useEffect(() => {
		void getNativeMediaHealth().then((health) =>
			setNativeNvencAvailable(Boolean(health?.h264Nvenc)),
		);
	}, []);

	const handleExport = async () => {
		if (!activeProject) return;
		const extension = getExportFileExtension({ format });
		const mimeType = getExportMimeType({ format });
		const filename = `${activeProject.metadata.name}${extension}`;
		let selection: ExportDestinationSelection;
		try {
			selection = await selectExportDestination({
				filename,
				mimeType,
				extension,
			});
		} catch (error) {
			console.error("Failed to select export destination:", error);
			toast.error("Could not open the export destination");
			return;
		}
		if (selection.status === "cancelled") return;

		const result = await editor.project.export({
			options: {
				format,
				quality: DEFAULT_EXPORT_OPTIONS.quality,
				fps:
					fpsSelection === "project"
						? activeProject.settings.fps
						: floatToFrameRate(outputFps),
				includeAudio: shouldIncludeAudio,
				width: outputDimensions.width,
				height: outputDimensions.height,
				videoBitrate,
				encoder,
				bitrateMode,
			},
			destination:
				selection.status === "selected" ? selection.destination : undefined,
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.buffer) {
			downloadBuffer({
				buffer: result.buffer,
				filename,
				mimeType,
			});
		}

		if (result.success) {
			editor.project.clearExportState();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	return (
		<PopoverContent className="bg-background mr-4 flex max-h-[85vh] w-96 flex-col overflow-y-auto p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
														if (value !== "mp4" && encoder === "native_nvenc") {
															setEncoder("auto");
														}
														if (value !== "mp4" && bitrateMode === "constant") {
															setBitrateMode("variable");
														}
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen>
										<SectionHeader>
											<SectionTitle>Output</SectionTitle>
										</SectionHeader>
										<SectionContent className="space-y-3">
											<ExportSelectRow label="Resolution">
												<Select
													value={resolutionPreset}
													onValueChange={(value) => {
														if (isResolutionPreset(value)) {
															setResolutionPreset(value);
														}
													}}
												>
													<SelectTrigger className="w-44">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														{EXPORT_RESOLUTION_PRESETS.map((preset) => {
															const dimensions = resolveExportDimensions({
																projectWidth:
																	activeProject.settings.canvasSize.width,
																projectHeight:
																	activeProject.settings.canvasSize.height,
																preset,
															});
															return (
																<SelectItem key={preset} value={preset}>
																	{preset === "project" ? "Project" : preset} ·{" "}
																	{dimensions.width}×{dimensions.height}
																</SelectItem>
															);
														})}
													</SelectContent>
												</Select>
											</ExportSelectRow>

											<ExportSelectRow label="Frame rate">
												<Select
													value={fpsSelection}
													onValueChange={setFpsSelection}
												>
													<SelectTrigger className="w-44">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="project">
															Project ·{" "}
															{projectFps.toFixed(2).replace(/\.00$/, "")} fps
														</SelectItem>
														{fpsOptions
															.filter(
																(fps) => Math.abs(fps - projectFps) > 0.01,
															)
															.map((fps) => (
																<SelectItem key={fps} value={String(fps)}>
																	{fps} fps
																</SelectItem>
															))}
													</SelectContent>
												</Select>
											</ExportSelectRow>

											<ExportSelectRow label="Encoder">
												<Select
													value={encoder}
													onValueChange={(value) => {
														if (isExportEncoder(value)) setEncoder(value);
													}}
												>
													<SelectTrigger className="w-44">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="auto">Auto · Browser</SelectItem>
														<SelectItem
															value="native_nvenc"
															disabled={
																format !== "mp4" || !nativeNvencAvailable
															}
														>
															NVIDIA NVENC · experimental
														</SelectItem>
														<SelectItem value="webcodecs">
															Browser WebCodecs
														</SelectItem>
													</SelectContent>
												</Select>
											</ExportSelectRow>
											{encoder === "native_nvenc" && (
												<p className="text-muted-foreground text-[11px] leading-relaxed">
													Experimental: this browser must copy composited frames
													to the local NVENC process. Auto is faster for this
													workstation today.
												</p>
											)}
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen>
										<SectionHeader>
											<SectionTitle>Compression</SectionTitle>
										</SectionHeader>
										<SectionContent className="space-y-3">
											<ExportSelectRow label="Rate control">
												<Select
													value={bitrateMode}
													onValueChange={(value) => {
														if (value === "variable" || value === "constant") {
															setBitrateMode(value);
														}
													}}
												>
													<SelectTrigger className="w-44">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="variable">
															Variable · efficient
														</SelectItem>
														<SelectItem
															value="constant"
															disabled={
																format !== "mp4" || !nativeNvencAvailable
															}
														>
															Constant · predictable
														</SelectItem>
													</SelectContent>
												</Select>
											</ExportSelectRow>
											<div className="flex items-center justify-between text-xs">
												<span className="text-muted-foreground">Quality</span>
												<span>{qualityValue}%</span>
											</div>
											<Slider
												min={1}
												max={100}
												step={1}
												value={[qualityValue]}
												onValueChange={(values) =>
													setQualityValue(values[0] ?? qualityValue)
												}
											/>
											<div className="grid grid-cols-2 gap-2 rounded-md border bg-accent/20 p-2 text-xs">
												<ExportSummary label="Output">
													{outputDimensions.width}×{outputDimensions.height} ·{" "}
													{outputFps.toFixed(2).replace(/\.00$/, "")} fps
												</ExportSummary>
												<ExportSummary label="Video bitrate">
													{(videoBitrate / 1_000_000).toFixed(1)} Mbps
												</ExportSummary>
												<ExportSummary label="Estimated size">
													{bitrateMode === "constant"
														? `~${formatExportSize(
																(estimatedSize.minimum +
																	estimatedSize.maximum) /
																	2,
															)}`
														: `${formatExportSize(estimatedSize.minimum)}–${formatExportSize(
																estimatedSize.maximum,
															)}`}
												</ExportSummary>
												<ExportSummary label="Duration">
													{formatExportDuration(durationSeconds * 1000)}
												</ExportSummary>
											</div>
											<p className="text-muted-foreground text-[11px] leading-relaxed">
												{bitrateMode === "constant"
													? "A fast native NVENC finishing pass keeps final size close to the estimate."
													: "Variable bitrate uses less space on simple footage, so size is shown as a range."}
											</p>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>
								</div>

								<div className="p-3 pt-0">
									<Button onClick={handleExport} className="w-full gap-2">
										<Download className="size-4" />
										Export
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
									<div className="text-muted-foreground grid grid-cols-2 gap-1 text-xs">
										<span>
											Frame {currentFrame?.toLocaleString() ?? 0} /{" "}
											{totalFrames?.toLocaleString() ?? "—"}
										</span>
										<span className="text-right">
											Elapsed {formatExportDuration(elapsedMs ?? 0)}
										</span>
										<span className="col-span-2">
											{etaMs
												? `About ${formatExportDuration(etaMs)} remaining`
												: "Estimating remaining time…"}
										</span>
									</div>
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportSelectRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<Label className="text-xs">{label}</Label>
			{children}
		</div>
	);
}

function ExportSummary({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="text-muted-foreground">{label}</span>
			<span className="truncate font-medium">{children}</span>
		</div>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
