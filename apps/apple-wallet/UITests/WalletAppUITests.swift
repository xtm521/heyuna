import XCTest

final class WalletAppUITests: XCTestCase {
    @MainActor
    func testOfflineWelcomeAndInvalidImport() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let create = app.buttons["wallet.create"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["wallet.send"].exists)
        let welcome = XCTAttachment(screenshot: app.screenshot())
        welcome.name = "welcome-no-account-no-network"
        welcome.lifetime = .keepAlways
        add(welcome)
        app.buttons["wallet.import"].tap()
        let input = app.secureTextFields["wallet.import.words"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("invalid words")
        app.buttons["wallet.import.continue"].tap()
        let prompt = app.alerts["操作提示"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        XCTAssertTrue(prompt.staticTexts["助记词格式或校验不正确。请核对单词和顺序。"].exists)
        prompt.buttons["好"].tap()
        app.buttons["取消"].tap()
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["wallet.send"].exists)
        // No real mnemonic, private key, user wallet, or external transaction enters this test.
    }
}
