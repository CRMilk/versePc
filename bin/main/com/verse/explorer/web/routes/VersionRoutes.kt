package com.verse.explorer.web.routes

import com.verse.explorer.web.models.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Routing.versionRoutes() {
    route("/versions") {
        get {
            val versions = listOf(
                VersionInfo("1.20.4", "release", "2023-12-07", true),
                VersionInfo("1.20.3", "release", "2023-12-05", true),
                VersionInfo("1.20.2", "release", "2023-10-13", true),
                VersionInfo("1.20.1", "release", "2023-06-12", true),
                VersionInfo("1.20", "release", "2023-06-05", true),
                VersionInfo("1.19.4", "release", "2023-03-14", false),
                VersionInfo("1.19.3", "release", "2022-12-07", false),
                VersionInfo("24w13a", "snapshot", "2024-03-27", false),
                VersionInfo("24w12a", "snapshot", "2024-03-20", false)
            )
            call.respond(ApiResponse(success = true, data = versions))
        }
        
        get("/remote") {
            val versions = listOf(
                VersionInfo("1.21", "release", "2024-06-13", false),
                VersionInfo("1.20.6", "release", "2024-04-29", false),
                VersionInfo("1.20.5", "release", "2024-04-23", false),
                VersionInfo("24w14a", "snapshot", "2024-04-03", false)
            )
            call.respond(ApiResponse(success = true, data = versions))
        }
        
        post("/download/{versionId}") {
            val versionId = call.parameters["versionId"] ?: return@post call.respond(
                ApiResponse<Nothing>(success = false, error = "Version ID required")
            )
            call.respond(ApiResponse(success = true, message = "Download started for $versionId"))
        }
        
        delete("/{versionId}") {
            val versionId = call.parameters["versionId"] ?: return@delete call.respond(
                ApiResponse<Nothing>(success = false, error = "Version ID required")
            )
            call.respond(ApiResponse(success = true, message = "Version $versionId deleted"))
        }
    }
}
