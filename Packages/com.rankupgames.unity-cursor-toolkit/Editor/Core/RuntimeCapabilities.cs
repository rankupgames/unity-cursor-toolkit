#if UNITY_EDITOR

using System;

namespace UnityCursorToolkit.Core
{
	internal static class RuntimeCapabilities
	{
		// Inspect the running Editor, not the selected Player scripting backend.
		private static readonly bool IsMono = typeof(object).Assembly.GetType("Mono.Runtime") != null;
		public static bool IsCoreCLR => !IsMono && string.Equals(
			typeof(object).Assembly.GetName().Name, "System.Private.CoreLib", StringComparison.Ordinal);

		// Runtime support for AppDomain reload. This is not the Enter Play Mode option.
		// Unknown runtimes advertise neither capability and cannot select the Mono path.
		public static bool HasDomainReload => IsMono;
	}
}

#endif
