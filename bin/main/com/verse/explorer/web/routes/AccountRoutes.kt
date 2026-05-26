package com.verse.explorer.web.routes

import com.verse.explorer.web.models.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Routing.accountRoutes() {
    route("/accounts") {
        get {
            val accounts = listOf(
                AccountInfo("1", "Player", "offline", true),
                AccountInfo("2", "Steve", "offline", false)
            )
            call.respond(ApiResponse(success = true, data = accounts))
        }
        
        post("/offline") {
            val request = call.receive<CreateOfflineAccountRequest>()
            val account = AccountInfo(
                id = System.currentTimeMillis().toString(),
                username = request.username,
                type = "offline",
                selected = true
            )
            call.respond(ApiResponse(success = true, data = account, message = "Account created"))
        }
        
        post("/select/{accountId}") {
            val accountId = call.parameters["accountId"] ?: return@post call.respond(
                ApiResponse<Nothing>(success = false, error = "Account ID required")
            )
            call.respond(ApiResponse(success = true, message = "Account $accountId selected"))
        }
        
        delete("/{accountId}") {
            val accountId = call.parameters["accountId"] ?: return@delete call.respond(
                ApiResponse<Nothing>(success = false, error = "Account ID required")
            )
            call.respond(ApiResponse(success = true, message = "Account $accountId deleted"))
        }
    }
}
