import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
	mediaId: string;
	/** Independent decoder cursor for this timeline clip, even for shared media. */
	decodeStreamId?: string;
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVisualSourceNodeState
> {}
