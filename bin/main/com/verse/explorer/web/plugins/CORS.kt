package com.verse.explorer.web.plugins

import io.ktor.server.application.*
import io.ktor.server.plugins.cors.routing.*

fun Application.configureCORS() {
    install(CORS) {
        anyHost()
        allowHeader { true }
        allowMethod { true }
        allowCredentials = true
        allowNonSimpleContentTypes = true
    }
}
