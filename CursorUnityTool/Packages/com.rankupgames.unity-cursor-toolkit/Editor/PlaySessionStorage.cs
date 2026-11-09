/*
 * Author: Miguel A. Lopez
 * Company: Rank Up Games LLC
 * Description: Lossless completed-capture storage. Shared blocks never imply shared object identity.
 */
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace UnityCursorToolkit
{
	/// <summary>Compaction is explicit idle-Editor maintenance, never capture-frame work.</summary>
	internal static class PlaySessionStorage
	{
		internal const long MaximumStorageBytes = 512L * 1024 * 1024;
		internal const int MaximumSnapshotBytes = 8 * 1024 * 1024;
		private const int MinimumBlockBytes = 4096;
		private const int MaximumBlockBytes = 65536;
		private const int MaximumBlocks = MaximumSnapshotBytes / MinimumBlockBytes + 1;
		private const int MaximumManifestBytes = 1024 * 1024;
		private const int MaximumPackBytes = MaximumSnapshotBytes + MaximumBlocks * 1104 + 32;
		private const int MaximumIndexedBlocks = 262144;
		private const string Format = "shared-gzip-blocks";
		private static readonly byte[] PackMagic = Encoding.ASCII.GetBytes("UCTPACK2");
		private static readonly byte[] FooterMagic = Encoding.ASCII.GetBytes("UCTEND02");
		private static readonly ulong[] Gear = MakeGear();

		[Serializable] internal sealed class Descriptor
		{
			public int storageVersion;
			public string format;
			public string sessionId;
			public string snapshotId;
			public int decodedBytes;
			public string sha256;
			public string manifest;
		}
		[Serializable] internal sealed class Block
		{
			public string pack;
			public long offset;
			public int storedBytes;
			public int decodedBytes;
			public string sha256;
		}
		[Serializable] internal sealed class Manifest
		{
			public int storageVersion = 2;
			public string sessionId;
			public string snapshotId;
			public int decodedBytes;
			public string sha256;
			public List<Block> blocks = new List<Block>();
		}
		internal sealed class Statistics
		{
			internal int compacted;
			internal int alreadyCompacted;
			internal int notSmaller;
			internal long decodedBytes;
			internal long physicalBefore;
			internal long physicalAfter;
		}

		internal static long Inventory(string root)
		{
			if (!Directory.Exists(root)) return 0;
			var pending = new Stack<DirectoryInfo>();
			pending.Push(new DirectoryInfo(root));
			long total = 0;
			int entries = 0;
			while (pending.Count > 0)
			{
				DirectoryInfo directory = pending.Pop();
				RejectLink(directory.FullName);
				foreach (FileSystemInfo item in directory.EnumerateFileSystemInfos())
				{
					if (++entries > 10000) throw new IOException("Session storage inventory exceeded 10000 entries.");
					RejectLink(item.FullName);
					var child = item as DirectoryInfo;
					if (child != null) pending.Push(child);
					else total = checked(total + ((FileInfo)item).Length);
				}
			}
			return total;
		}

		internal static byte[] Read(string root, string sessionId, string snapshotId)
		{
			string path = CapturePath(root, sessionId, snapshotId);
			byte[] bytes = ReadBounded(path, MaximumSnapshotBytes);
			Descriptor descriptor = JsonUtility.FromJson<Descriptor>(Json(bytes));
			if (descriptor == null || descriptor.storageVersion == 0) return bytes;
			Validate(descriptor, sessionId, snapshotId);
			Manifest manifest = ReadManifest(root, descriptor);
			byte[] decoded = Decode(root, manifest);
			if (decoded.Length != descriptor.decodedBytes || Hash(decoded) != descriptor.sha256)
				throw new IOException("Snapshot descriptor does not match its decoded bytes.");
			return decoded;
		}

		internal static void CompareBytes(byte[] first, byte[] second, out long sharedSecondBytes, out long uniqueSecondBytes)
		{
			var hashes = new HashSet<string>(StringComparer.Ordinal);
			for (int start = 0; start < first.Length;)
			{
				int length = BlockLength(first, start);
				byte[] block = new byte[length]; Buffer.BlockCopy(first, start, block, 0, length);
				hashes.Add(Hash(block)); start += length;
			}
			sharedSecondBytes = 0;
			for (int start = 0; start < second.Length;)
			{
				int length = BlockLength(second, start);
				byte[] block = new byte[length]; Buffer.BlockCopy(second, start, block, 0, length);
				if (hashes.Contains(Hash(block))) sharedSecondBytes += length;
				start += length;
			}
			uniqueSecondBytes = second.Length - sharedSecondBytes;
		}

		internal static string Json(byte[] bytes)
		{
			try
			{
				using (var input = new MemoryStream(bytes, false))
				using (var reader = new StreamReader(input, new UTF8Encoding(false, true), true)) return reader.ReadToEnd();
			}
			catch (DecoderFallbackException exception) { throw new IOException("Snapshot is not valid UTF-8.", exception); }
		}

		internal static Statistics Compact(string root, string sessionId)
		{
			if (!PlaySessionMonitor.ValidSessionId(sessionId)) throw new ArgumentException("Invalid session ID.");
			string directory = Child(root, sessionId);
			var summary = JsonUtility.FromJson<PlaySessionSummary>(Json(ReadBounded(Child(directory, "session.json"), MaximumSnapshotBytes)));
			DateTime ended;
			if (summary == null || summary.version != 1 || summary.id != sessionId || string.IsNullOrEmpty(summary.endedUtc) ||
				!DateTime.TryParse(summary.endedUtc, null, System.Globalization.DateTimeStyles.RoundtripKind, out ended) ||
				summary.snapshotCount < 0 || summary.snapshotCount > PlaySessionMonitor.MaximumSnapshots)
				throw new IOException("Only a valid, completed session can be compacted.");
			var stats = new Statistics { physicalBefore = Inventory(root) };
			var index = LoadIndex(root);
			for (int number = 1; number <= summary.snapshotCount; number++)
			{
				string snapshotId = "snapshot-" + number.ToString("D4", System.Globalization.CultureInfo.InvariantCulture);
				string path = CapturePath(root, sessionId, snapshotId);
				byte[] original = ReadBounded(path, MaximumSnapshotBytes);
				Descriptor descriptor = JsonUtility.FromJson<Descriptor>(Json(original));
				if (descriptor != null && descriptor.storageVersion != 0)
				{
					byte[] decoded = Read(root, sessionId, snapshotId);
					stats.decodedBytes += decoded.Length;
					stats.alreadyCompacted++;
					continue;
				}
				var snapshot = JsonUtility.FromJson<PlaySessionSnapshot>(Json(original));
				if (snapshot == null || snapshot.version != 1 || snapshot.sessionId != sessionId || snapshot.id != snapshotId || snapshot.objects == null)
					throw new IOException("Legacy snapshot identity is invalid. Its original bytes were preserved.");
				stats.decodedBytes += original.Length;
				if (CompactCapture(root, path, sessionId, snapshotId, original, index)) stats.compacted++;
				else stats.notSmaller++;
			}
			stats.physicalAfter = Inventory(root);
			return stats;
		}

		private static bool CompactCapture(string root, string path, string sessionId, string snapshotId, byte[] original, Dictionary<string, Block> index)
		{
			string manifestName = snapshotId + ".manifest.json";
			string manifestPath = Child(Child(root, sessionId), manifestName);
			var manifest = new Manifest { sessionId = sessionId, snapshotId = snapshotId, decodedBytes = original.Length, sha256 = Hash(original) };
			string packId = string.Empty;
			var additions = new List<Block>();
			using (var pack = new MemoryStream())
			{
				pack.Write(PackMagic, 0, PackMagic.Length);
				int start = 0;
				while (start < original.Length)
				{
					int length = BlockLength(original, start);
					byte[] raw = new byte[length];
					Buffer.BlockCopy(original, start, raw, 0, length);
					string hash = Hash(raw);
					Block block;
					if (!index.TryGetValue(hash, out block))
					{
						byte[] compressed = Compress(raw);
						block = new Block { pack = packId, offset = pack.Position, storedBytes = compressed.Length, decodedBytes = length, sha256 = hash };
						pack.Write(compressed, 0, compressed.Length);
						additions.Add(block);
						index.Add(hash, block);
					}
					if (block.decodedBytes != length) throw new IOException("Shared block hash has conflicting decoded lengths.");
					manifest.blocks.Add(block);
					start += length;
				}
				FinishPack(pack, additions);
				// Stable payload identity also makes interrupted staging reusable on retry.
				packId = Hash(pack.ToArray()).Substring(0, 32);
				foreach (Block block in additions) block.pack = packId;
				byte[] manifestBytes = Encoding.UTF8.GetBytes(JsonUtility.ToJson(manifest));
				if (manifestBytes.Length > MaximumManifestBytes || pack.Length > MaximumPackBytes) throw new IOException("Snapshot storage representation exceeded its bound.");
				var descriptor = new Descriptor { storageVersion = 2, format = Format, sessionId = sessionId, snapshotId = snapshotId,
					decodedBytes = original.Length, sha256 = manifest.sha256, manifest = manifestName };
				byte[] descriptorBytes = Encoding.UTF8.GetBytes(JsonUtility.ToJson(descriptor));
				long newBytes = descriptorBytes.Length + manifestBytes.Length + (additions.Count == 0 ? 0 : pack.Length);
				if (!File.Exists(manifestPath) && newBytes >= original.Length)
				{
					foreach (Block block in additions) index.Remove(block.sha256);
					return false;
				}
				// Interrupted publication may leave a complete immutable manifest. Verify it instead of replacing it.
				if (File.Exists(manifestPath))
				{
					Manifest retained = ReadManifest(root, descriptor);
					RequireOriginal(original, Decode(root, retained));
					foreach (Block block in additions) index.Remove(block.sha256);
				}
				else
				{
					if (Inventory(root) > MaximumStorageBytes - newBytes - descriptorBytes.Length)
						throw new IOException("Compaction needs bounded temporary space below the 512 MiB ceiling. No capture was removed.");
					if (additions.Count > 0)
					{
						string blocksDirectory = Child(root, "blocks");
						Directory.CreateDirectory(blocksDirectory);
						PublishNew(root, Child(blocksDirectory, "pack-" + packId + ".bin"), pack.ToArray());
					}
					PublishNew(root, manifestPath, manifestBytes);
					RequireOriginal(original, Decode(root, manifest));
				}
				string pending = Child(Child(root, sessionId), snapshotId + ".storage-pending");
				CompleteStaging(root, pending, descriptorBytes);
				// File.Replace atomically publishes a verified descriptor without a backup file.
				File.Replace(pending, path, null);
				return true;
			}
		}

		private static void RequireOriginal(byte[] original, byte[] decoded)
		{
			if (decoded.Length != original.Length || Hash(decoded) != Hash(original) || !Equal(original, decoded))
				throw new IOException("Snapshot round-trip verification failed. Original capture was not replaced.");
		}

		private static Manifest ReadManifest(string root, Descriptor descriptor)
		{
			Validate(descriptor, descriptor.sessionId, descriptor.snapshotId);
			var manifest = JsonUtility.FromJson<Manifest>(Json(ReadBounded(Child(Child(root, descriptor.sessionId), descriptor.manifest), MaximumManifestBytes)));
			if (manifest == null || manifest.storageVersion != 2 || manifest.sessionId != descriptor.sessionId || manifest.snapshotId != descriptor.snapshotId ||
				manifest.decodedBytes != descriptor.decodedBytes || manifest.sha256 != descriptor.sha256 || manifest.blocks == null ||
				manifest.blocks.Count == 0 || manifest.blocks.Count > MaximumBlocks) throw new IOException("Snapshot manifest identity or bounds are invalid.");
			return manifest;
		}

		private static byte[] Decode(string root, Manifest manifest)
		{
			if (manifest.decodedBytes < 1 || manifest.decodedBytes > MaximumSnapshotBytes) throw new IOException("Decoded snapshot length is invalid.");
			var packs = new Dictionary<string, Dictionary<string, Block>>(StringComparer.Ordinal);
			using (var output = new MemoryStream(manifest.decodedBytes))
			{
				foreach (Block block in manifest.blocks)
				{
					Validate(block);
					Dictionary<string, Block> footer;
					if (!packs.TryGetValue(block.pack, out footer)) { footer = ReadPack(root, block.pack); packs.Add(block.pack, footer); }
					Block stored;
					if (!footer.TryGetValue(block.sha256, out stored) || stored.offset != block.offset || stored.storedBytes != block.storedBytes || stored.decodedBytes != block.decodedBytes)
						throw new IOException("Manifest block does not match its immutable pack footer.");
					if (output.Length > manifest.decodedBytes - block.decodedBytes) throw new IOException("Decoded snapshot exceeds its declared bound.");
					byte[] compressed = new byte[block.storedBytes];
					using (var input = File.OpenRead(PackPath(root, block.pack)))
					{
						input.Position = block.offset;
						ReadExactly(input, compressed, compressed.Length);
					}
					byte[] raw = Expand(compressed, block.decodedBytes);
					if (Hash(raw) != block.sha256) throw new IOException("Decoded block hash does not match its manifest.");
					output.Write(raw, 0, raw.Length);
				}
				byte[] decoded = output.ToArray();
				if (decoded.Length != manifest.decodedBytes || Hash(decoded) != manifest.sha256) throw new IOException("Decoded snapshot hash or length is invalid.");
				return decoded;
			}
		}

		private static Dictionary<string, Block> LoadIndex(string root)
		{
			var index = new Dictionary<string, Block>(StringComparer.Ordinal);
			string directory = Child(root, "blocks");
			if (!Directory.Exists(directory)) return index;
			foreach (string path in Directory.GetFiles(directory, "pack-*.bin"))
			{
				string name = Path.GetFileName(path);
				string id = name.Substring(5, name.Length - 9);
				foreach (Block block in ReadPack(root, id).Values)
				{
					Block existing;
					if (index.TryGetValue(block.sha256, out existing))
					{
						if (existing.decodedBytes != block.decodedBytes) throw new IOException("Pack index has conflicting block lengths.");
					}
					else index.Add(block.sha256, block);
					if (index.Count > MaximumIndexedBlocks) throw new IOException("Shared block index exceeds its bounded entry count.");
				}
			}
			return index;
		}

		private static Dictionary<string, Block> ReadPack(string root, string packId)
		{
			string path = PackPath(root, packId);
			using (var input = File.OpenRead(path))
			using (var reader = new BinaryReader(input, Encoding.ASCII, true))
			{
				if (input.Length < 28 || input.Length > MaximumPackBytes || !Equal(reader.ReadBytes(8), PackMagic)) throw new IOException("Shared pack header or length is invalid.");
				input.Position = input.Length - 16;
				long footerOffset = reader.ReadInt64();
				if (!Equal(reader.ReadBytes(8), FooterMagic) || footerOffset < 8 || footerOffset > input.Length - 20) throw new IOException("Shared pack footer is invalid.");
				input.Position = footerOffset;
				int count = reader.ReadInt32();
				if (count < 1 || count > MaximumBlocks || input.Length - footerOffset != 20L + count * 80L) throw new IOException("Shared pack footer bounds are invalid.");
				var blocks = new Dictionary<string, Block>(StringComparer.Ordinal);
				long next = 8;
				for (int index = 0; index < count; index++)
				{
					var block = new Block { pack = packId, sha256 = Encoding.ASCII.GetString(reader.ReadBytes(64)), offset = reader.ReadInt64(), storedBytes = reader.ReadInt32(), decodedBytes = reader.ReadInt32() };
					Validate(block);
					if (block.offset != next || block.offset > footerOffset - block.storedBytes || blocks.ContainsKey(block.sha256)) throw new IOException("Shared pack blocks overlap or repeat.");
					blocks.Add(block.sha256, block);
					next += block.storedBytes;
				}
				if (next != footerOffset) throw new IOException("Shared pack payload has unindexed bytes.");
				return blocks;
			}
		}

		private static void FinishPack(MemoryStream pack, List<Block> blocks)
		{
			long footerOffset = pack.Position;
			using (var writer = new BinaryWriter(pack, Encoding.ASCII, true))
			{
				writer.Write(blocks.Count);
				foreach (Block block in blocks)
				{
					writer.Write(Encoding.ASCII.GetBytes(block.sha256)); writer.Write(block.offset);
					writer.Write(block.storedBytes); writer.Write(block.decodedBytes);
				}
				writer.Write(footerOffset); writer.Write(FooterMagic);
			}
		}

		private static void Validate(Descriptor descriptor, string sessionId, string snapshotId)
		{
			if (descriptor.storageVersion != 2 || descriptor.format != Format || descriptor.sessionId != sessionId || descriptor.snapshotId != snapshotId ||
				!PlaySessionMonitor.ValidSessionId(sessionId) || !PlaySessionMonitor.ValidSnapshotId(snapshotId) || descriptor.manifest != snapshotId + ".manifest.json" ||
				descriptor.decodedBytes < 1 || descriptor.decodedBytes > MaximumSnapshotBytes || !Hex(descriptor.sha256, 64)) throw new IOException("Snapshot storage descriptor is invalid.");
		}

		private static void Validate(Block block)
		{
			if (block == null || !Hex(block.pack, 32) || !Hex(block.sha256, 64) || block.offset < 8 || block.storedBytes < 1 ||
				block.decodedBytes < 1 || block.decodedBytes > MaximumBlockBytes || block.storedBytes > block.decodedBytes + 1024) throw new IOException("Shared block reference is invalid.");
		}

		private static bool Hex(string text, int length)
		{
			if (text == null || text.Length != length) return false;
			foreach (char c in text) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
			return true;
		}

		private static string CapturePath(string root, string sessionId, string snapshotId)
		{
			if (!PlaySessionMonitor.ValidSessionId(sessionId) || !PlaySessionMonitor.ValidSnapshotId(snapshotId)) throw new ArgumentException("Invalid capture identity.");
			return Child(Child(root, sessionId), snapshotId + ".json");
		}
		private static string PackPath(string root, string id)
		{
			if (!Hex(id, 32)) throw new IOException("Shared pack identity is invalid.");
			return Child(Child(root, "blocks"), "pack-" + id + ".bin");
		}
		internal static string EvidenceFile(string directory, string name) { return Child(directory, name); }

		private static string Child(string directory, string name)
		{
			if (string.IsNullOrEmpty(name) || name.IndexOfAny(new[] { '/', '\\', ':' }) >= 0 || name == "." || name == "..") throw new IOException("Evidence path is invalid.");
			RejectLink(directory);
			string path = Path.Combine(directory, name);
			RejectLink(path);
			return path;
		}
		private static void RejectLink(string path)
		{
			try
			{
				if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Session evidence cannot traverse symbolic links.");
			}
			catch (FileNotFoundException) { }
			catch (DirectoryNotFoundException) { }
		}
		private static byte[] ReadBounded(string path, int maximum)
		{
			RejectLink(path);
			if (!File.Exists(path)) throw new IOException("Required session evidence is missing.");
			using (var input = File.OpenRead(path))
			{
				if (input.Length > maximum) throw new IOException("Session artifact exceeds its bounded read limit.");
				byte[] bytes = new byte[(int)input.Length];
				ReadExactly(input, bytes, bytes.Length);
				if (input.ReadByte() != -1) throw new IOException("Session artifact changed during its bounded read.");
				return bytes;
			}
		}
		private static void PublishNew(string root, string path, byte[] bytes)
		{
			string pending = path + ".pending";
			CompleteStaging(root, pending, bytes);
			File.Move(pending, path);
		}
		private static void CompleteStaging(string root, string pending, byte[] expected)
		{
			RejectLink(pending);
			using (var output = new FileStream(pending, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
			{
				long retained = output.Length;
				if (retained > expected.Length) throw new IOException("Owned staging exceeds its expected publication length.");
				var buffer = new byte[4096];
				int verified = 0;
				while (verified < retained)
				{
					int count = output.Read(buffer, 0, (int)Math.Min(buffer.Length, retained - verified));
					if (count == 0) throw new IOException("Owned staging changed during prefix verification.");
					for (int index = 0; index < count; index++)
						if (buffer[index] != expected[verified + index]) throw new IOException("Owned staging conflicts with its expected publication bytes.");
					verified += count;
				}
				// Count only the remaining suffix, including when a retained manifest skips initial publication.
				if (Inventory(root) > MaximumStorageBytes - (expected.Length - verified))
					throw new IOException("Resumed staging would exceed the 512 MiB evidence ceiling. Original capture was preserved.");
				// Only a verified truncated prefix is repaired. Published evidence is never rewritten here.
				output.Write(expected, verified, expected.Length - verified);
				output.Flush(true);
			}
		}
		private static byte[] Compress(byte[] raw)
		{
			using (var output = new MemoryStream())
			{
				using (var gzip = new GZipStream(output, System.IO.Compression.CompressionLevel.Optimal, true)) gzip.Write(raw, 0, raw.Length);
				return output.ToArray();
			}
		}
		private static byte[] Expand(byte[] compressed, int length)
		{
			try { return ExpandBlock(compressed, length); }
			catch (InvalidDataException exception) { throw new IOException("Compressed block is invalid.", exception); }
		}
		private static byte[] ExpandBlock(byte[] compressed, int length)
		{
			using (var input = new MemoryStream(compressed, false))
			using (var gzip = new GZipStream(input, CompressionMode.Decompress))
			{
				byte[] raw = new byte[length];
				ReadExactly(gzip, raw, length);
				if (gzip.ReadByte() != -1) throw new IOException("Compressed block exceeds its decoded length.");
				return raw;
			}
		}
		private static void ReadExactly(Stream input, byte[] bytes, int count)
		{
			int read = 0;
			while (read < count)
			{
				int got = input.Read(bytes, read, count - read);
				if (got == 0) throw new IOException("Session block is truncated.");
				read += got;
			}
		}
		private static bool Equal(byte[] left, byte[] right)
		{
			if (left.Length != right.Length) return false;
			for (int index = 0; index < left.Length; index++) if (left[index] != right[index]) return false;
			return true;
		}
		private static string Hash(byte[] bytes)
		{
			using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant();
		}
		private static int BlockLength(byte[] bytes, int start)
		{
			ulong hash = 0;
			int end = Math.Min(bytes.Length, start + MaximumBlockBytes);
			for (int index = start; index < end; index++)
			{
				unchecked { hash = (hash << 1) + Gear[bytes[index]]; }
				if (index - start + 1 >= MinimumBlockBytes && (hash & 16383UL) == 0) return index - start + 1;
			}
			return end - start;
		}
		private static ulong[] MakeGear()
		{
			var gear = new ulong[256];
			ulong state = 0x9e3779b97f4a7c15UL;
			for (int index = 0; index < gear.Length; index++)
			{
				state ^= state << 13; state ^= state >> 7; state ^= state << 17; gear[index] = state;
			}
			return gear;
		}
	}
}
#endif
