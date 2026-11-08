#if UNITY_EDITOR

using System;
using System.Reflection;
using System.Collections.Generic;

namespace UnityCursorToolkit.Core
{
	internal static class AssemblyEnumerator
	{
		internal static IReadOnlyList<Assembly> GetLoaded()
		{
#if UNITY_6000_8_OR_NEWER || UNITY_7000_0_OR_NEWER
			return UnityEngine.Assemblies.CurrentAssemblies.GetLoadedAssemblies();
#else
			return AppDomain.CurrentDomain.GetAssemblies();
#endif
		}
	}
}

#endif
