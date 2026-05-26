package com.verse.explorer.web.models

data class ApiResponse<T>(
    val success: Boolean,
    val data: T? = null,
    val message: String? = null,
    val error: String? = null
)

data class VersionInfo(
    val id: String,
    val type: String,
    val releaseDate: String,
    val installed: Boolean
)

data class AccountInfo(
    val id: String,
    val username: String,
    val type: String,
    val selected: Boolean
)

data class CreateOfflineAccountRequest(
    val username: String
)

data class SettingsInfo(
    val gameDir: String,
    val maxMemory: Int,
    val minMemory: Int,
    val rendererType: String,
    val showVirtualMouse: Boolean,
    val virtualKeyOpacity: Float,
    val theme: String,
    val language: String,
    val keepScreenOn: Boolean,
    val showFps: Boolean,
    val forceLandscape: Boolean
)

data class ModInfo(
    val name: String,
    val version: String,
    val enabled: Boolean,
    val description: String
)

data class GameStatus(
    val isRunning: Boolean,
    val version: String,
    val fps: Int,
    val memoryUsed: Long,
    val memoryMax: Long
)

data class DownloadProgress(
    val versionId: String,
    val progress: Float,
    val speed: String,
    val status: String
)

data class NewsItem(
    val title: String,
    val summary: String,
    val date: String,
    val url: String? = null
)
