import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import process from "node:process";
import {
	getGroupRoles,
	streamGroupMembers,
	type GroupMemberEntry,
	type Roleset
} from "./groupsScraper";
import { streamFriends } from "./usersScraper";
import {
	checkLotsOfUsers,
	flagTypeToString,
	type UserStatus
} from "./rotector";

interface GroupConfig {
	id: string;
	cap?: number;
}

interface CliOptions {
	friendIds: string[];
	groups: GroupConfig[];
	outputDir: string;
	verbose: boolean;
}

interface SourceRunSummary {
	type: "friends" | "group";
	targetId: string;
	label: string;
	totalUsers: number;
	uniqueUsers: number;
	newlyChecked: number;
	indexFile: string;
	flagBreakdown: Record<string, number>;
}

interface ProcessResult {
	totalCollected: number;
	uniqueUsers: number;
	newlyChecked: number;
	flagBreakdown: Record<string, number>;
	unsafeMatches: number;
}

interface StatusSnapshot {
	totalCollected: number;
	uniqueUsers: number;
	matchedUsers: number;
	unsafeMatches: number;
	queueSize: number;
}

interface Logger {
	readonly verboseEnabled: boolean;
	status(message: string): void;
	statusDone(finalMessage?: string): void;
	log(message: string): void;
	warn(message: string): void;
	verbose(message: string): void;
}

function createLogger(verbose: boolean): Logger {
	let statusActive = false;
	let lastStatusLength = 0;

	const prefix = "[status] ";

	function status(message: string) {
		if (verbose) {
			console.log(`${prefix}${message}`);
			return;
		}
		const line = `${prefix}${message}`;
		const padding = Math.max(0, lastStatusLength - message.length);
		process.stdout.write(`\r${" ".repeat(lastStatusLength)}${"\b".repeat(lastStatusLength)}`);
		process.stdout.write(`${line}${" ".repeat(padding)}\r`);
		lastStatusLength = message.length;
		statusActive = true;
	}

	function statusDone(finalMessage?: string) {
		if (verbose) {
			if (finalMessage) console.log(`${prefix}${finalMessage}`);
			return;
		}
		if (finalMessage) {
			const padding = Math.max(0, lastStatusLength - finalMessage.length);
			process.stdout.write(
				`\r${prefix}${finalMessage}${" ".repeat(padding)}\n`
			);
		} else if (statusActive) {
			process.stdout.write("\n");
		}
		statusActive = false;
		lastStatusLength = 0;
	}

	function log(message: string) {
		if (!verbose) {
			statusDone();
		}
		console.log(message);
	}

	function warn(message: string) {
		if (!verbose) {
			statusDone();
		}
		console.warn(message);
	}

	function verboseLog(message: string) {
		if (verbose) {
			console.log(message);
		}
	}

	return {
		verboseEnabled: verbose,
		status,
		statusDone,
		log,
		warn,
		verbose: verboseLog
	};
}

const statusCache = new Map<number, UserStatus>();
const LOOKUP_BATCH_SIZE = 50;

function formatTimestamp(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function printHelp() {
	console.log(`robloxHELL CLI\n\nUsage:\n  bun run src/index.ts --output <dir> [options]\n\nOptions:\n  -o, --output <dir>      Directory to write reports (required)\n  -f, --friend <id[,id]>  Roblox user ID(s) whose friends are scraped\n  -g, --group <id[:cap]>  Roblox group ID to scrape, optional cap per group\n  -v, --verbose           Print detailed progress (disables single-line status)\n  -h, --help              Show this help message\n\nYou must set the COOKIE environment variable with a valid .ROBLOSECURITY token.\nMultiple --friend and --group flags may be provided.`);
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		friendIds: [],
		groups: [],
		outputDir: "",
		verbose: false
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				printHelp();
				process.exit(0);
			case "-o":
			case "--output":
			case "--out": {
				const dir = argv[++i];
				if (!dir) throw new Error("Missing value for --output");
				opts.outputDir = dir;
				break;
			}
			case "-f":
			case "--friend":
			case "--friends": {
				const idsRaw = argv[++i];
				if (!idsRaw)
					throw new Error("Missing value for --friend/--friends");
				for (const id of idsRaw.split(",")) {
					const trimmed = id.trim();
					if (!trimmed) continue;
					if (!/^\d+$/.test(trimmed))
						throw new Error(`Invalid Roblox user id: ${trimmed}`);
					opts.friendIds.push(trimmed);
				}
				break;
			}
			case "-g":
			case "--group": {
				const groupRaw = argv[++i];
				if (!groupRaw) throw new Error("Missing value for --group");
				const [groupIdRaw, capRaw] = groupRaw.split(":");
				if (!/^\d+$/.test(groupIdRaw!))
					throw new Error(`Invalid Roblox group id: ${groupIdRaw}`);
				const cfg: GroupConfig = { id: groupIdRaw! };
				if (capRaw !== undefined) {
					const parsed = Number(capRaw);
					if (Number.isNaN(parsed) || parsed <= 0)
						throw new Error(
							`Invalid member cap for group ${groupIdRaw}: ${capRaw}`
						);
					cfg.cap = parsed;
				}
				opts.groups.push(cfg);
				break;
			}
			case "-v":
			case "--verbose": {
				opts.verbose = true;
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return opts;
}

function persistCache(results: Record<string, UserStatus>) {
	for (const [userId, status] of Object.entries(results)) {
		statusCache.set(Number(userId), status);
	}
}

async function appendLine(stream: WriteStream, text: string): Promise<void> {
	if (!stream.write(`${text}\n`)) {
		await once(stream, "drain");
	}
}

async function appendJsonLine(
	stream: WriteStream,
	payload: Record<string, unknown>
): Promise<void> {
	await appendLine(stream, JSON.stringify(payload));
}

async function closeWriter(stream: WriteStream): Promise<void> {
	stream.end();
	await once(stream, "close");
}

function ensureTargetDir(
	runDir: string,
	type: "friends" | "group",
	targetId: string
): { dirPath: string; relativeDir: string } {
	const relativeDir = `${type}-${targetId}`;
	const dirPath = join(runDir, relativeDir);
	mkdirSync(dirPath, { recursive: true });
	return { dirPath, relativeDir };
}

interface ProcessEntriesOptions<Entry> {
	runId: string;
	type: "friends" | "group";
	targetId: string;
	label: string;
	metadata?: Record<string, unknown>;
	entryStream: AsyncIterable<Entry>;
	extractUserId(entry: Entry): number;
	onEntryCollected(entry: Entry): Promise<void>;
	rotectorWriter: WriteStream;
	logger: Logger;
	statusUpdater?: (snapshot: StatusSnapshot) => void;
}

async function processEntries<Entry>({
	runId,
	type,
	targetId,
	label,
	metadata,
	entryStream,
	extractUserId,
	onEntryCollected,
	rotectorWriter,
	logger,
	statusUpdater
}: ProcessEntriesOptions<Entry>): Promise<ProcessResult> {
	const seenIds = new Set<number>();
	const pendingLookup: number[] = [];
	const flagBreakdown: Record<string, number> = {};

	let totalCollected = 0;
	let uniqueUsers = 0;
	let newlyChecked = 0;
	let unsafeMatches = 0;

	const getMatchedUsers = () =>
		Object.values(flagBreakdown).reduce((sum, count) => sum + count, 0);

	const emitStatus = () => {
		if (!statusUpdater) return;
		statusUpdater({
			totalCollected,
			uniqueUsers,
			matchedUsers: getMatchedUsers(),
			unsafeMatches,
			queueSize: pendingLookup.length
		});
	};

	const writeStatus = async (status: UserStatus) => {
		const flagLabel = flagTypeToString(status.flagType);
		flagBreakdown[flagLabel] = (flagBreakdown[flagLabel] ?? 0) + 1;
		if (status.flagType !== 0) unsafeMatches++;

		await appendJsonLine(rotectorWriter, {
			runId,
			generatedAt: new Date().toISOString(),
			source: {
				type,
				targetId,
				label,
				...(metadata ?? {})
			},
			user: {
				id: status.id,
				flagType: status.flagType,
				flagLabel,
				status
			}
		});
	};

	const flushLookup = async () => {
		if (!pendingLookup.length) return;
		const chunk = pendingLookup.splice(0);
		logger.verbose(
			`[${label}] checking ${chunk.length} user(s) against Rotector`
		);
		const lookupResults = await checkLotsOfUsers(chunk);
		persistCache(lookupResults);
		newlyChecked += chunk.length;

		for (const id of chunk) {
			const status = lookupResults[id.toString()];
			if (status) {
				await writeStatus(status);
			} else {
				logger.warn(`[${label}] missing Rotector data for ${id}`);
			}
		}

		emitStatus();
	};

	for await (const entry of entryStream) {
		await onEntryCollected(entry);
		const userId = extractUserId(entry);
		totalCollected++;

		if (seenIds.has(userId)) {
			continue;
		}

		seenIds.add(userId);
		uniqueUsers++;

		const cached = statusCache.get(userId);
		if (cached) {
			await writeStatus(cached);
			continue;
		}

		pendingLookup.push(userId);
		if (pendingLookup.length >= LOOKUP_BATCH_SIZE) {
			await flushLookup();
		}

		emitStatus();
	}

	await flushLookup();
	emitStatus();

	return {
		totalCollected,
		uniqueUsers,
		newlyChecked,
		flagBreakdown,
		unsafeMatches
	};
}

function buildIndexPayload(args: {
	runId: string;
	type: "friends" | "group";
	targetId: string;
	label: string;
	metadata?: Record<string, unknown>;
	stats: ProcessResult;
	files: Record<string, unknown>;
}): Record<string, unknown> {
	const { runId, type, targetId, label, metadata, stats, files } = args;
	const uniqueMatched = Object.values(stats.flagBreakdown).reduce(
		(sum, count) => sum + count,
		0
	);

	return {
		runId,
		generatedAt: new Date().toISOString(),
		source: {
			type,
			targetId,
			label,
			...(metadata ?? {})
		},
		counts: {
			totalCollected: stats.totalCollected,
			uniqueCollected: stats.uniqueUsers,
			uniqueMatched,
			newlyChecked: stats.newlyChecked,
			unsafeMatches: stats.unsafeMatches
		},
		flagBreakdown: stats.flagBreakdown,
		files
	};
}

function formatStatusLine(label: string, snapshot: StatusSnapshot): string {
	const pendingMatches = Math.max(
		0,
		snapshot.uniqueUsers - snapshot.matchedUsers
	);
	return `${label} :: total ${snapshot.totalCollected} | unique ${snapshot.uniqueUsers} | matched ${snapshot.matchedUsers} (unsafe ${snapshot.unsafeMatches}) | queue ${snapshot.queueSize} | pending ${pendingMatches}`;
}

async function processFriendSource(
	friendId: string,
	runDir: string,
	runId: string,
	logger: Logger
): Promise<SourceRunSummary> {
	const type = "friends";
	const label = `friends:${friendId}`;
	const { dirPath, relativeDir } = ensureTargetDir(runDir, type, friendId);
	const usersWriter = createWriteStream(join(dirPath, "users"), {
		flags: "a"
	});
	const rotectorWriter = createWriteStream(join(dirPath, "rotector"), {
		flags: "a"
	});

	logger.status(`${label} initializing...`);

	const stats = await processEntries<number>({
		runId,
		type,
		targetId: friendId,
		label,
		metadata: { subjectUserId: friendId },
		entryStream: streamFriends(friendId),
		extractUserId: (id) => id,
		onEntryCollected: async (id) => {
			await appendLine(usersWriter, id.toString());
		},
		rotectorWriter,
		logger,
		statusUpdater: (snapshot) => {
			logger.status(formatStatusLine(label, snapshot));
		}
	});

	logger.statusDone(
		`${label} complete :: unique ${stats.uniqueUsers} / unsafe ${stats.unsafeMatches}`
	);

	await closeWriter(usersWriter);
	await closeWriter(rotectorWriter);

	const indexPayload = buildIndexPayload({
		runId,
		type,
		targetId: friendId,
		label,
		metadata: { subjectUserId: friendId },
		stats,
		files: {
			index: "index.json",
			users: "users",
			rotector: "rotector"
		}
	});

	writeFileSync(
		join(dirPath, "index.json"),
		JSON.stringify(indexPayload, undefined, 2)
	);

	return {
		type,
		targetId: friendId,
		label,
		totalUsers: stats.totalCollected,
		uniqueUsers: stats.uniqueUsers,
		newlyChecked: stats.newlyChecked,
		indexFile: join(relativeDir, "index.json"),
		flagBreakdown: stats.flagBreakdown
	};
}

async function processGroupSource(
	group: GroupConfig,
	runDir: string,
	runId: string,
	logger: Logger
): Promise<SourceRunSummary> {
	const type = "group";
	const label = `group:${group.id}`;
	const { dirPath, relativeDir } = ensureTargetDir(runDir, type, group.id);

	const roles = await getGroupRoles(group.id);
	writeFileSync(
		join(dirPath, "roles.json"),
		JSON.stringify(
			{
				runId,
				generatedAt: new Date().toISOString(),
				groupId: group.id,
				roles
			},
			undefined,
			2
		)
	);

	const roleWriters = new Map<number, WriteStream>();
	const roleCounts: Record<string, number> = {};

	const createRoleWriters = (rolesets: Roleset[]) => {
		for (const role of rolesets) {
			const writer = createWriteStream(join(dirPath, `${role.id}`), {
				flags: "a"
			});
			roleWriters.set(role.id, writer);
		}
	};

	createRoleWriters(roles);

	const rotectorWriter = createWriteStream(join(dirPath, "rotector"), {
		flags: "a"
	});

	logger.status(`${label} initializing...`);

	const stats = await processEntries<GroupMemberEntry>({
		runId,
		type,
		targetId: group.id,
		label,
		metadata: { groupId: group.id, cap: group.cap ?? null },
		entryStream: streamGroupMembers(group.id, group.cap, roles),
		extractUserId: (entry) => entry.userId,
		onEntryCollected: async (entry) => {
			const writer = roleWriters.get(entry.rolesetId);
			if (!writer)
				throw new Error(`Missing writer for roleset ${entry.rolesetId}`);
			roleCounts[entry.rolesetId.toString()] =
				(roleCounts[entry.rolesetId.toString()] ?? 0) + 1;
			await appendLine(writer, entry.userId.toString());
		},
		rotectorWriter,
		logger,
		statusUpdater: (snapshot) => {
			logger.status(formatStatusLine(label, snapshot));
		}
	});

	logger.statusDone(
		`${label} complete :: unique ${stats.uniqueUsers} / unsafe ${stats.unsafeMatches}`
	);

	await Promise.all([...roleWriters.values()].map((w) => closeWriter(w)));
	await closeWriter(rotectorWriter);

	const indexPayload = buildIndexPayload({
		runId,
		type,
		targetId: group.id,
		label,
		metadata: { groupId: group.id, cap: group.cap ?? null },
		stats,
		files: {
			index: "index.json",
			rotector: "rotector",
			roles: "roles.json",
			roleFiles: Object.keys(roleCounts).length
				? roleCounts
				: roles.reduce<Record<string, number>>((acc, role) => {
						acc[role.id.toString()] = 0;
						return acc;
				  }, {})
		}
	});

	writeFileSync(
		join(dirPath, "index.json"),
		JSON.stringify(indexPayload, undefined, 2)
	);

	return {
		type,
		targetId: group.id,
		label,
		totalUsers: stats.totalCollected,
		uniqueUsers: stats.uniqueUsers,
		newlyChecked: stats.newlyChecked,
		indexFile: join(relativeDir, "index.json"),
		flagBreakdown: stats.flagBreakdown
	};
}

async function main() {
	const runId = formatTimestamp();

	try {
		const options = parseArgs(process.argv.slice(2));
		const logger = createLogger(options.verbose);

		if (!options.outputDir)
			throw new Error("--output directory is required");
		if (!options.friendIds.length && !options.groups.length)
			throw new Error("Provide at least one --friend or --group target");
		if (!process.env.COOKIE)
			throw new Error("COOKIE environment variable (.ROBLOSECURITY) is missing");

		const resolvedOutput = resolve(process.cwd(), options.outputDir);
		mkdirSync(resolvedOutput, { recursive: true });
		const runDir = join(resolvedOutput, runId);
		mkdirSync(runDir, { recursive: true });

		const summaries: SourceRunSummary[] = [];

		for (const friendId of options.friendIds) {
			summaries.push(
				await processFriendSource(friendId, runDir, runId, logger)
			);
		}

		for (const group of options.groups) {
			logger.verbose(
				`[group:${group.id}] streaming members${
					group.cap ? ` (cap ${group.cap})` : ""
				}...`
			);
			summaries.push(await processGroupSource(group, runDir, runId, logger));
		}

		const aggregateBreakdown: Record<string, number> = {};
		for (const summary of summaries) {
			for (const [label, count] of Object.entries(summary.flagBreakdown)) {
				aggregateBreakdown[label] =
					(aggregateBreakdown[label] ?? 0) + count;
			}
		}

		const summaryPayload = {
			runId,
			generatedAt: new Date().toISOString(),
			runDirectory: runDir,
			stats: {
				sourcesAnalyzed: summaries.length,
				uniqueUsersMatched: statusCache.size,
				totalIdsCollected: summaries.reduce(
					(acc, s) => acc + s.totalUsers,
					0
				)
			},
			flagBreakdown: aggregateBreakdown,
			sources: summaries
		};

		const summaryFile = join(runDir, "summary.json");
		writeFileSync(summaryFile, JSON.stringify(summaryPayload, undefined, 2));

		logger.statusDone();
		logger.log(
			`Run complete. Wrote ${summaries.length} target folder(s) under ${runDir}`
		);
	} catch (err) {
		if (err instanceof Error) {
			console.error(err.message);
		} else {
			console.error(err);
		}
		process.exit(1);
	}
}

await main();
