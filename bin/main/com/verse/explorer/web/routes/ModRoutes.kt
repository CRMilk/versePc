package com.verse.explorer.web.routes

import com.verse.explorer.web.models.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Routing.modRoutes() {
    route("/mods") {
        get {
            val mods = listOf(
                ModInfo("Sodium", "0.5.8", true, "Performance mod"),
                ModInfo("Iris Shaders", "1.6.10", true, "Shader support"),
                ModInfo("Lithium", "0.12.1", true, "Server optimization"),
                ModInfo("Fabric API", "0.96.11", true, "Fabric mod loader API"),
                ModInfo("Mod Menu", "9.0.0", true, "Mod list viewer"),
                ModInfo("REI", "14.0.688", false, "Recipe viewer")
            )
            call.respond(ApiResponse(success = true, data = mods))
        }
        
        post("/toggle/{modName}") {
            val modName = call.parameters["modName"] ?: return@post call.respond(
                ApiResponse<Nothing>(success = false, error = "Mod name required")
            )
            call.respond(ApiResponse(success = true, message = "Mod $modName toggled"))
        }
        
        delete("/{modName}") {
            val modName = call.parameters["modName"] ?: return@delete call.respond(
                ApiResponse<Nothing>(success = false, error = "Mod name required")
            )
            call.respond(ApiResponse(success = true, message = "Mod $modName deleted"))
        }
    }
}
