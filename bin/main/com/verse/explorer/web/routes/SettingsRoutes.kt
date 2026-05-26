package com.verse.explorer.web.routes

import com.verse.explorer.web.models.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Routing.settingsRoutes() {
    route("/settings") {
        get {
            val settings = SettingsInfo(
                gameDir = "/storage/emulated/0/VerseExplorerX",
                maxMemory = 2048,
                minMemory = 512,
                rendererType = "Zink",
                showVirtualMouse = true,
                virtualKeyOpacity = 0.7f,
                theme = "深色",
                language = "简体中文",
                keepScreenOn = true,
                showFps = false,
                forceLandscape = true
            )
            call.respond(ApiResponse(success = true, data = settings))
        }
        
        post {
            val settings = call.receive<SettingsInfo>()
            call.respond(ApiResponse(success = true, data = settings, message = "Settings saved"))
        }
        
        post("/reset") {
            call.respond(ApiResponse(success = true, message = "Settings reset to defaults"))
        }
    }
}
