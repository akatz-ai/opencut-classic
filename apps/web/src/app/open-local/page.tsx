"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { z } from "zod";

// A desktop launch gets its own window. Share the in-flight UI action across
// React StrictMode effects so a mount cannot accidentally create two projects.
const imports = new Map<string, Promise<string>>();

async function requestImport({
	ticket,
	action,
}: {
	ticket: string;
	action: string;
}): Promise<Response> {
	const response = await fetch("/api/local-open", {
		method: "POST",
		cache: "no-store",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ticket, action }),
	});
	if (!response.ok)
		throw new Error(
			"The selected file is unavailable or the import link expired. Open it from Dolphin again.",
		);
	return response;
}

async function importSelectedFile(ticket: string): Promise<string> {
	const key = `opencut-local-open:${ticket}`;
	const saved = z
		.object({ projectId: z.string().uuid(), done: z.boolean() })
		.nullable()
		.parse(JSON.parse(sessionStorage.getItem(key) ?? "null"));
	if (saved?.done) return saved.projectId;
	const metadata = z
		.object({
			name: z.string(),
			mime: z.string().startsWith("video/"),
			size: z.number().positive(),
			lastModified: z.number(),
		})
		.parse(await (await requestImport({ ticket, action: "inspect" })).json());
	const editor = EditorCore.getInstance();
	const projectId =
		saved?.projectId ??
		(await editor.project.createNewProject({
			name: new Intl.DateTimeFormat("sv-SE", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				fractionalSecondDigits: 3,
			}).format(new Date()),
		}));
	sessionStorage.setItem(key, JSON.stringify({ projectId, done: false }));
	await editor.project.loadProject({ id: projectId });
	// A refresh after a completed save must not import the clip twice.
	if (editor.media.getAssets().length === 0) {
		const blob = await (await requestImport({ ticket, action: "read" })).blob();
		if (blob.size !== metadata.size)
			throw new Error("The file transfer was incomplete. Reload to retry.");
		const file = new File([blob], metadata.name, {
			type: metadata.mime,
			lastModified: metadata.lastModified,
		});
		const assets = await processMediaAssets({ files: [file] });
		if (assets.length !== 1)
			throw new Error(
				"OpenCut could not import this video. The new empty project is preserved.",
			);
		const added = await editor.media.addMediaAsset({
			projectId,
			asset: assets[0],
		});
		if (!added)
			throw new Error(
				"Could not save the imported video. Check browser storage and reload to retry.",
			);
	}
	await editor.save.flush();
	sessionStorage.setItem(key, JSON.stringify({ projectId, done: true }));
	await requestImport({ ticket, action: "complete" }).catch(() => undefined);
	// Intentionally no timeline.insertElement: this action imports to the bin only.
	return projectId;
}

export default function OpenLocalPage() {
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const ticket =
			new URLSearchParams(window.location.hash.slice(1)).get("ticket") ?? "";
		let mounted = true;
		const job =
			imports.get(ticket) ??
			(/^[a-f0-9]{64}$/.test(ticket)
				? importSelectedFile(ticket)
				: Promise.reject(
						new Error(
							"Choose a video in Dolphin and select Open With → OpenCut.",
						),
					));
		imports.set(ticket, job);
		void job
			.then((projectId) => {
				if (mounted) window.location.replace(`/editor/${projectId}`);
			})
			.catch((err: unknown) => {
				imports.delete(ticket);
				if (mounted)
					setError(err instanceof Error ? err.message : "Import failed");
			});
		return () => {
			mounted = false;
		};
	}, []);
	return (
		<main className="bg-background text-foreground flex min-h-screen items-center justify-center p-8">
			<div className="max-w-lg space-y-4 text-center">
				<h1 className="text-2xl font-semibold">
					{error ? "Could not open video" : "Opening video in OpenCut…"}
				</h1>
				<p>
					{error ??
						"Creating a new project and importing your clip into the media library. The timeline will stay empty."}
				</p>
				{error && (
					<Link className="underline" href="/projects">
						Go to projects
					</Link>
				)}
			</div>
		</main>
	);
}
