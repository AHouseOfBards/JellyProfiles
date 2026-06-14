using System;
using System.Collections.Generic;
using Jellyfin.Profiles.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Profiles
{
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        public override string Name => "Bonfire/JellyProfiles";
        public override Guid Id => Guid.Parse("b1462fca-774b-4b13-8d02-e2d4f2bc18b9");

        public static Plugin? Instance { get; private set; }

        public IApplicationPaths AppPaths { get; }

        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            AppPaths = applicationPaths;
        }

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = "Profiles",
                    DisplayName = "Profiles",
                    EnableInMainMenu = true,
                    EmbeddedResourcePath = GetType().Namespace + ".Web.profilesDashboard.html"
                }
            };
        }
    }
}
