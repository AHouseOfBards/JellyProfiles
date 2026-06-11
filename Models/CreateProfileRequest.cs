using System;
using System.Collections.Generic;

namespace Jellyfin.Profiles.Models
{
    public class CreateProfileRequest
    {
        public string ProfileName { get; set; } = string.Empty;
        public string? Pin { get; set; }
        public string AvatarColor { get; set; } = "#1F77B4";
        public string? MaxParentalRating { get; set; }
        public List<Guid>? EnabledFolders { get; set; }
        public string? MasterPin { get; set; }
        /// <summary>Minutes of inactivity before auto-lock. 0 = never. Null = use default (5).</summary>
        public int? LockoutMinutes { get; set; }
    }
}
