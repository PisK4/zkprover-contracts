import { ethers } from 'hardhat'
import {
	EntryPoint,
	EntryPoint__factory,
	AccountFactory,
	Account,
	Account__factory,
	TestCounter,
	TestCounter__factory,
	TestToken__factory,
	TestToken,
	ZkProverZkpVerifierWrapper,
	ZkProverZkpVerifierWrapper__factory,
} from '../typechain-types'
import {
	AddressZero,
	createAccount,
	createAccountOwner,
	createAddress,
	fund,
	generateBatchofERC20TransferOp,
	rethrow,
	tostr
} from './testutils'
import { BigNumber, PopulatedTransaction, Wallet } from 'ethers'
import { expect } from 'chai'
import { fillAndSign } from "./UserOp"
import { UserOperationStruct } from "../typechain-types/contracts/Account";
import { compile_yul, halo2zkpVerifierAbi } from '../scripts/utils'
import ProofData from "./zkp_output/proof.json";

const testLoopLimit = 128

describe('0.Counter.test', () => {
	let entryPoint: EntryPoint
	let verifier: ZkProverZkpVerifierWrapper
	const ethersSigners = ethers.provider.getSigner()
	let accountOwner: Wallet
	let account: Account

	before(async () => {
		accountOwner = createAccountOwner()
		let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");

		const factory = new ethers.ContractFactory(
			halo2zkpVerifierAbi,
			verifyCode,
			ethersSigners
		  );
		  const verifyContract = await factory.deploy();
		verifier = await new ZkProverZkpVerifierWrapper__factory(
			ethersSigners
		  ).deploy(verifyContract.address);
		  
		entryPoint = await new EntryPoint__factory(ethersSigners).deploy(verifier.address)

		account = await new Account__factory(ethersSigners).deploy(
			entryPoint.address
		)
		await fund(accountOwner.address)
	})

	it('check contract is deployed', async () => {
		expect(
			await ethers.provider.getCode(entryPoint.address).then((x) => x.length)
		).to.be.greaterThan(2)
		expect(
			await ethers.provider.getCode(account.address).then((x) => x.length)
		).to.be.greaterThan(2)

		console.log('verfier address:', verifier.address)
		console.log('EntryPoint deployed to:', entryPoint.address)
		console.log('Account deployed to:', account.address)
	})

	describe('test handle ops', () => {
		let counter: TestCounter
		let accountExecCounterFromEntryPoint: PopulatedTransaction
		let account2: Account
		const accountOwner2 = createAccountOwner()
		const beneficiaryAddress = createAddress()

		before(async () => {
			counter = await new TestCounter__factory(ethersSigners).deploy()
			console.log('TestCounter deployed to:', counter.address)
		})

		it('new account handleOp, first time', async () => {
			const count = await counter.populateTransaction.count()

			accountExecCounterFromEntryPoint =
				await account.populateTransaction.execute(
					counter.address,
					0,
					count.data!
				)
			;({ proxy: account2 } = await createAccount(
				ethersSigners,
				await accountOwner2.getAddress(),
				entryPoint.address
			))

			const op = await fillAndSign(
				{
					callData: accountExecCounterFromEntryPoint.data,
					sender: account2.address,
					callGasLimit: 2e6,
					verificationGasLimit: 1e6
				},
				accountOwner2,
				entryPoint
			)

			await fund(account2.address)


			try {
				const tx = await entryPoint
				.handleOps([op],        
					ProofData.proof,
					[BigNumber.from(ProofData.pub_ins[0])], 
					beneficiaryAddress,
					{
						maxFeePerGas: 1e9,
						gasLimit: 30000000,
					})
				.catch(rethrow())
				.then(async (r) => r!.wait())		
				console.log('gasused:', tx.gasUsed.toString())		
			} catch (error) {
				console.log('error:', error)
			}

			expect(
				await ethers.provider.getCode(counter.address).then((x) => x.length)
			).to.be.greaterThan(2)

			expect(await counter.counters(account2.address)).to.equal(1)
		})

		it('new account handleOp, second time', async () => {
			const count = await counter.populateTransaction.count()

			accountExecCounterFromEntryPoint =
				await account.populateTransaction.execute(
					counter.address,
					0,
					count.data!
				)
			;({ proxy: account2 } = await createAccount(
				ethersSigners,
				await accountOwner2.getAddress(),
				entryPoint.address
			))

			const op = await fillAndSign(
				{
					callData: accountExecCounterFromEntryPoint.data,
					sender: account2.address,
					callGasLimit: 2e6,
					verificationGasLimit: 1e6
				},
				accountOwner2,
				entryPoint
			)

			await fund(account2.address)
			const tx = await entryPoint.handleOps([op],        
				ProofData.proof,
				[BigNumber.from(ProofData.pub_ins[0])], 
				beneficiaryAddress,
				{
					maxFeePerGas: 1e9,
					gasLimit: 30000000,
				})
				.catch(rethrow())
				.then(async (r) => r!.wait())

			console.log('gasused:', tx.gasUsed.toString())

			expect(
				await ethers.provider.getCode(counter.address).then((x) => x.length)
			).to.be.greaterThan(2)

			expect(await counter.counters(account2.address)).to.equal(1)
		})
	})
})

describe('1.transferERC20.test', () => {
	let entryPoint: EntryPoint
	let entryPointzkp: EntryPoint
	let verifier: ZkProverZkpVerifierWrapper
	const ethersSigners = ethers.provider.getSigner()
	let accountOwner: Wallet
	let refundAccount: Wallet
	let account: Account
	let token: TestToken
	let beneficiaryAddress: string
	let gasFirst: number
	let gasSecond: number
	const accountOwners: Wallet[] = []
	const accountFactorys: AccountFactory[] = []

	before(async () => {
		accountOwner = createAccountOwner()
		beneficiaryAddress = createAddress()
		refundAccount = createAccountOwner()

		entryPointzkp = await new EntryPoint__factory(ethersSigners).deploy(
			AddressZero
		)
		let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");

		const factory = new ethers.ContractFactory(
			halo2zkpVerifierAbi,
			verifyCode,
			ethersSigners
		  );
		  const verifyContract = await factory.deploy();
		verifier = await new ZkProverZkpVerifierWrapper__factory(
			ethersSigners
		  ).deploy(verifyContract.address);
		entryPoint = await new EntryPoint__factory(ethersSigners).deploy(verifier.address)

		// entryPointPis = await new EntryPointPis__factory(ethersSigners).deploy()
		account = await new Account__factory(ethersSigners).deploy(
			entryPoint.address
		)
		token = await new TestToken__factory(ethersSigners).deploy()
	})

	it('handle ERC20 mint Op', async () => {
		let execcallData: PopulatedTransaction
		let ERCaccount: Account

		const mintcallData = await token.populateTransaction.mint(
			beneficiaryAddress,
			1000
		)

		execcallData = await account.populateTransaction.execute(
			token.address,
			0,
			mintcallData.data!
		)
		;({ proxy: ERCaccount } = await createAccount(
			ethersSigners,
			await accountOwner.getAddress(),
			entryPoint.address
		))

		await fund(ERCaccount.address)

		const op = await fillAndSign(
			{
				callData: execcallData.data,
				sender: ERCaccount.address,
				callGasLimit: 2e6,
				verificationGasLimit: 1e6
			},
			accountOwner,
			entryPoint
		)

		const tx = await entryPoint.handleOps([op],        
			ProofData.proof,
			[BigNumber.from(ProofData.pub_ins[0])], 
			beneficiaryAddress,
			{
				maxFeePerGas: 1e9,
				gasLimit: 30000000,
			})
			.catch(rethrow())
			.then(async (r) => r!.wait())

		const balance = await token.balanceOf(beneficiaryAddress)
		expect(balance).to.equal(1000)
	})

	it('handle ERC20 transfer Op for one time', async () => {
		let erc20TransfercallData: PopulatedTransaction
		let ercAccount: Account

		const transfercallData = await token.populateTransaction.transfer(
			beneficiaryAddress,
			100
		)

		erc20TransfercallData = await account.populateTransaction.execute(
			token.address,
			0,
			transfercallData.data!
		)
		;({ proxy: ercAccount } = await createAccount(
			ethersSigners,
			await accountOwner.getAddress(),
			entryPoint.address
		))

		await fund(ercAccount.address)
		await token.mint(ercAccount.address, 500)

		const op = await fillAndSign(
			{
				callData: erc20TransfercallData.data,
				sender: ercAccount.address,
				callGasLimit: 2e6,
				verificationGasLimit: 1e6
			},
			accountOwner,
			entryPoint
		)

		const tx = await entryPoint.handleOps([op],        
			ProofData.proof,
			[BigNumber.from(ProofData.pub_ins[0])], 
			beneficiaryAddress,
			{
				maxFeePerGas: 1e9,
				gasLimit: 30000000,
			})
			.then(async (r) => r!.wait())

		const balance = await token.balanceOf(beneficiaryAddress)
		expect(balance).to.equal(1100)
	})

	it('[Gas Trace] - 1st handle batch of ERC20 transfer Ops', async () => {
		const ops: UserOperationStruct[] = []
		let accountFactory: AccountFactory

		for (let testLoop = 0; testLoop < testLoopLimit; testLoop++) {
			const { op, accountOwner, accountFactory } =
				await generateBatchofERC20TransferOp(
					ethersSigners,
					token,
					entryPoint,
					account,
					testLoop
				)
			ops.push(op)
			accountOwners.push(accountOwner)
			accountFactorys.push(accountFactory)
		}

		console.log(
			'  estimateGas=',
			await entryPoint.estimateGas
			.handleOps(ops,        
				ProofData.proof,
				[BigNumber.from(ProofData.pub_ins[0])], 
				beneficiaryAddress,
				{
					maxFeePerGas: 1e9,
					gasLimit: 30000000,
				})
				.then(tostr)
		)

		const tx = await entryPoint.handleOps(ops,        
			ProofData.proof,
			[BigNumber.from(ProofData.pub_ins[0])], 
			beneficiaryAddress,
			{
				maxFeePerGas: 1e9,
				gasLimit: 30000000,
			})
			.then(async (t) => await t.wait())

		console.log(
			'batch transfer gasused:',
			tx.gasUsed.toString(),
			'avgGas:',
			tx.gasUsed.div(testLoopLimit).toString(),
			'tx:',
			testLoopLimit
		)

		gasFirst = tx.gasUsed.toNumber()

		for (let testloop = 0; testloop < testLoopLimit; testloop++) {
			const balance = await token.balanceOf(accountOwners[testloop].address)
			expect(balance).to.equal((testloop + 1) * 100)
		}
	})

	it('[Gas Trace] - 2th handle batch of ERC20 transfer Ops', async () => {
		const ops: UserOperationStruct[] = []

		for (let testLoop = 0; testLoop < testLoopLimit; testLoop++) {
			const { op, accountOwner } = await generateBatchofERC20TransferOp(
				ethersSigners,
				token,
				entryPoint,
				account,
				testLoop,
				undefined,
				undefined,
				accountOwners[testLoop],
				accountFactorys[testLoop]
			)
			ops.push(op)
		}

		console.log(
			'  estimateGas=',
			await entryPoint.estimateGas
			.handleOps(ops,        
				ProofData.proof,
				[BigNumber.from(ProofData.pub_ins[0])], 
				beneficiaryAddress, { maxFeePerGas: 1e9 })
				.then(tostr)
		)

		const tx = await entryPoint.handleOps(ops,        
			ProofData.proof,
			[BigNumber.from(ProofData.pub_ins[0])], 
			beneficiaryAddress,
			{
				maxFeePerGas: 1e9,
				gasLimit: 30000000,
			})
			.then(async (t) => await t.wait())

		console.log(
			'batch transfer gasused:',
			tx.gasUsed.toString(),
			'avgGas:',
			tx.gasUsed.div(testLoopLimit).toString(),
			'tx:',
			testLoopLimit
		)

		gasSecond = tx.gasUsed.toNumber()
	})

	it('compare gas difference', async () => {
		if (gasFirst != undefined && gasSecond != undefined) {
			console.log('gasFirst:', gasFirst, 'gasSecond:', gasSecond)
			console.log(
				'gasdiff:',
				gasFirst - gasSecond,
				'gasdiff%:',
				(gasFirst - gasSecond) / gasFirst
			)
			//expect(gasFirst).to.be.greaterThan(gasSecond)
		}
	})

})
