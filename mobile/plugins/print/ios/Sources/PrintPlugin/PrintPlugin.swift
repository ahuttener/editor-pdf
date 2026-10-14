import Foundation
import UIKit
import Capacitor

// Imprime um PDF (base64) com a tela de impressão do iOS (AirPrint)
@objc(PrintPlugin)
public class PrintPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PrintPlugin"
    public let jsName = "Printer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "printPdf", returnType: CAPPluginReturnPromise)
    ]

    @objc func printPdf(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("PDF ausente")
            return
        }
        let name = call.getString("name") ?? "Documento"
        DispatchQueue.main.async {
            let controller = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.outputType = .general
            info.jobName = name
            controller.printInfo = info
            controller.printingItem = data
            controller.present(animated: true) { _, completed, error in
                if let error = error { call.reject(error.localizedDescription) } else { call.resolve(["completed": completed]) }
            }
        }
    }
}
