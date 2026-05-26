package com.verse.explorer.web.plugins

import com.verse.explorer.web.routes.*
import io.ktor.server.application.*
import io.ktor.server.http.content.*
import io.ktor.server.routing.*

fun Application.configureRouting() {
    routing {
        route("/api") {
            versionRoutes()
            accountRoutes()
            settingsRoutes()
            modRoutes()
            gameRoutes()
        }
        
        staticResources("/", "web") {
            default("index.html")
        }
        
        get("/") {
            call.respondRedirect("/index.html")
        }
    }
}
